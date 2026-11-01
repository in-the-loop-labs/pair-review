// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { requireFields, normalizeComment, updateResult } = require('../review-comment-edit-utils');
const { commentId, reviewId } = require('../rest/review-comment-edit');

const UPDATE_ENDPOINT = '/repos/{owner}/{repo}/pulls/comments/{comment_id}';
const LIST_ENDPOINT = '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments';

function endpoint(template, values) {
  // Defense in depth: never allow endpoint configuration to send credentials
  // outside the bound host, even when constructed without config validation.
  if (typeof template !== 'string' || !template.startsWith('/') || template.startsWith('//') || /[\\\r\n]/.test(template)) {
    throw new Error('review_comment_edit endpoint must be a relative path');
  }
  return template.replace(/\{(owner|repo|pull_number|comment_id|review_id)\}/g, (_match, key) => {
    requireFields(values, [key]);
    return encodeURIComponent(String(values[key]));
  });
}

async function updateReviewComment(octokit, features, ref, body) {
  requireFields(ref, ['owner', 'repo']);
  const id = await commentId(octokit, ref);
  const path = endpoint(features.review_comment_edit_endpoint || UPDATE_ENDPOINT, { ...ref, comment_id: id });
  const { data } = await octokit.request(`PATCH ${path}`, { body });
  return updateResult(data);
}

async function listCommentsForReview(octokit, features, ref) {
  requireFields(ref, ['owner', 'repo', 'pull_number']);
  const id = await reviewId(octokit, ref);
  const path = endpoint(features.review_comment_edit_list_endpoint || LIST_ENDPOINT, { ...ref, review_id: id });
  const rows = await octokit.paginate(`GET ${path}`, { per_page: 100 });
  return rows.map(normalizeComment);
}

module.exports = { updateReviewComment, listCommentsForReview };
