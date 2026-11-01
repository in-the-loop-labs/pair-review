// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { failure, requireFields, normalizeComment, updateResult } = require('../review-comment-edit-utils');

// A node-only ref is resolved with a read, never by posting a replacement.
async function commentId(octokit, ref) {
  if (ref?.github_comment_id) return String(ref.github_comment_id);
  requireFields(ref, ['github_comment_node_id']);
  const result = await octokit.graphql(`query($id: ID!) {
    node(id: $id) { ... on PullRequestReviewComment { fullDatabaseId } }
  }`, { id: ref.github_comment_node_id });
  if (!result.node?.fullDatabaseId) throw failure('not_found', 'Review comment not found');
  return String(result.node.fullDatabaseId);
}

async function reviewId(octokit, ref) {
  if (ref?.github_review_id) return String(ref.github_review_id);
  requireFields(ref, ['github_node_id']);
  const result = await octokit.graphql(`query($id: ID!) {
    node(id: $id) { ... on PullRequestReview { fullDatabaseId } }
  }`, { id: ref.github_node_id });
  if (!result.node?.fullDatabaseId) throw failure('not_found', 'Review not found');
  return String(result.node.fullDatabaseId);
}

async function updateReviewComment(octokit, ref, body) {
  requireFields(ref, ['owner', 'repo']);
  const id = await commentId(octokit, ref);
  const { data } = await octokit.rest.pulls.updateReviewComment({
    owner: ref.owner, repo: ref.repo, comment_id: id, body
  });
  return updateResult(data);
}

async function listCommentsForReview(octokit, ref) {
  requireFields(ref, ['owner', 'repo', 'pull_number']);
  const id = await reviewId(octokit, ref);
  const rows = await octokit.paginate(octokit.rest.pulls.listCommentsForReview, {
    owner: ref.owner, repo: ref.repo, pull_number: ref.pull_number,
    review_id: id, per_page: 100
  });
  return rows.map(normalizeComment);
}

module.exports = { updateReviewComment, listCommentsForReview, commentId, reviewId };
