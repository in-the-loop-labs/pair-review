// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { failure, requireFields, normalizeComment, updateResult } = require('../review-comment-edit-utils');
const restImpl = require('../rest/review-comment-edit');

async function commentNodeId(octokit, ref) {
  if (ref?.github_comment_node_id) return ref.github_comment_node_id;
  requireFields(ref, ['owner', 'repo', 'github_comment_id']);
  const { data } = await octokit.rest.pulls.getReviewComment({
    owner: ref.owner, repo: ref.repo, comment_id: ref.github_comment_id
  });
  if (!data.node_id) throw failure('invalid_ref', 'Comment read did not return a node id');
  return data.node_id;
}

async function reviewNodeId(octokit, ref) {
  if (ref?.github_node_id) return ref.github_node_id;
  requireFields(ref, ['owner', 'repo', 'pull_number', 'github_review_id']);
  const { data } = await octokit.rest.pulls.getReview({
    owner: ref.owner, repo: ref.repo, pull_number: ref.pull_number,
    review_id: ref.github_review_id
  });
  if (!data.node_id) throw failure('invalid_ref', 'Review read did not return a node id');
  return data.node_id;
}

async function updateReviewComment(octokit, ref, body) {
  const id = await commentNodeId(octokit, ref);
  const result = await octokit.graphql(`mutation($id: ID!, $body: String!) {
    updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) {
      pullRequestReviewComment { id fullDatabaseId url body }
    }
  }`, { id, body });
  const row = result.updatePullRequestReviewComment?.pullRequestReviewComment;
  if (!row) throw failure('not_found', 'Updated review comment was not returned');
  return updateResult({ id: row.fullDatabaseId, node_id: row.id, html_url: row.url, body: row.body });
}

async function listCommentsForReview(octokit, ref) {
  const id = await reviewNodeId(octokit, ref);
  const rows = [];
  let cursor = null;
  let reviewId = ref.github_review_id;
  do {
    const result = await octokit.graphql(`query($id: ID!, $cursor: String) {
      node(id: $id) { ... on PullRequestReview {
        fullDatabaseId
        comments(first: 100, after: $cursor) {
          nodes {
            id fullDatabaseId url body path line startLine originalLine originalStartLine
            subjectType createdAt author { login } replyTo { id fullDatabaseId }
          }
          pageInfo { hasNextPage endCursor }
        }
      } }
    }`, { id, cursor });
    if (!result.node?.comments) throw failure('not_found', 'Review not found');
    reviewId = reviewId ?? result.node.fullDatabaseId;
    for (const row of result.node.comments.nodes) {
      rows.push(normalizeComment({
        id: row.fullDatabaseId, node_id: row.id, html_url: row.url,
        body: row.body, path: row.path, line: row.line, start_line: row.startLine,
        original_line: row.originalLine, original_start_line: row.originalStartLine,
        subject_type: row.subjectType?.toLowerCase(), created_at: row.createdAt,
        user: row.author, in_reply_to_id: row.replyTo ? (row.replyTo.fullDatabaseId ?? row.replyTo.id ?? 'unknown-reply') : null
      }));
    }
    const info = result.node.comments.pageInfo;
    if (!info.hasNextPage) break;
    if (!info.endCursor || info.endCursor === cursor) throw new Error('Review comment pagination did not advance');
    cursor = info.endCursor;
  } while (true);

  // GitHub's GraphQL comment type exposes no diff side fields. Enrich from
  // the same review's REST list (also includes the author's pending comments),
  // never infer RIGHT or mistake an outdated comment for a file comment.
  if (rows.some(row => row.subject_type !== 'file')) {
    requireFields(ref, ['owner', 'repo', 'pull_number']);
    if (!reviewId) throw failure('invalid_ref', 'Review has no REST id for diff-side lookup');
    const geometry = await restImpl.listCommentsForReview(octokit, { ...ref, github_review_id: reviewId });
    const byId = new Map(geometry.map(row => [row.id, row]));
    for (const row of rows) {
      const match = row.id == null ? null : byId.get(row.id);
      if (match) { row.side = match.side; row.start_side = match.start_side; }
    }
  }
  return rows;
}

module.exports = { updateReviewComment, listCommentsForReview };
