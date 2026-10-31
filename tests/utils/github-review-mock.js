// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/** Install per-server, stateful GitHub review mocks for the E2E servers. */
function installGitHubReviewMock(GitHubClient) {
  const pending = new Map();
  const reviews = new Map();
  const reviewComments = new Map();
  // Keep the real edit dispatcher/GraphQL adapter in the browser tests. Only
  // the wire transport is fake; unexpected operations cannot reach GitHub.
  const buildOctokit = GitHubClient.prototype._buildOctokit;
  if (buildOctokit) GitHubClient.prototype._buildOctokit = function () {
    const octokit = buildOctokit.call(this);
    octokit.graphql = async (query, variables) => {
      if (!query.includes('updatePullRequestReviewComment')) throw new Error('Unexpected E2E GraphQL operation');
      const values = Object.values(variables);
      const target = values.map(value => reviewComments.get(String(value))).find(Boolean);
      const body = variables.body;
      if (!target || body?.includes('E2E_FAIL_UPDATE_404')) {
        throw Object.assign(new Error('Comment not found on GitHub'), { status: 404 });
      }
      target.body = body;
      return { updatePullRequestReviewComment: { pullRequestReviewComment: {
        id: target.node_id, fullDatabaseId: target.id, url: target.html_url, body
      } } };
    };
    return octokit;
  };
  let nextId = 12345;
  const keyFor = ({ owner, repo, prNumber }) => `${owner}/${repo}/${prNumber}`;

  GitHubClient.prototype.getPendingReviewForUser = async (owner, repo, prNumber) =>
    pending.get(keyFor({ owner, repo, prNumber })) || null;
  GitHubClient.prototype.getReviewById = async id => reviews.get(String(id)) || null;

  function save(body, comments, existingReviewId, context, state) {
    const key = keyFor(context);
    const old = existingReviewId ? reviews.get(String(existingReviewId)) : null;
    const databaseId = old?.databaseId || nextId++;
    const id = old?.id || `PRR_test${databaseId}`;
    const url = `https://github.com/${context.owner}/${context.repo}/pull/${context.prNumber}#pullrequestreview-${databaseId}`;
    const review = {
      id, databaseId, url, html_url: url, state, body: state === 'PENDING' ? old?.body ?? body : body,
      comments: { totalCount: (old?.comments.totalCount || 0) + comments.length },
      comments_count: comments.length,
      submittedAt: state === 'PENDING' ? null : new Date().toISOString()
    };
    review.submitted_at = review.submittedAt;
    // Only newly added comments are returned by submit transports.
    review.postedComments = comments.map((comment, index) => ({
      index,
      github_comment_id: String(databaseId * 1000 + (old?.comments.totalCount || 0) + index),
      github_comment_node_id: `PRRC_test${databaseId}_${(old?.comments.totalCount || 0) + index}`,
      github_comment_url: `${url}-comment-${(old?.comments.totalCount || 0) + index}`
    }));
    for (const result of review.postedComments) {
      const sent = comments[result.index];
      const stored = { id: result.github_comment_id, node_id: result.github_comment_node_id,
        html_url: result.github_comment_url, body: sent.body, path: sent.path };
      reviewComments.set(stored.id, stored);
      reviewComments.set(stored.node_id, stored);
    }
    reviews.set(id, review);
    reviews.set(String(databaseId), review);
    if (state === 'PENDING') pending.set(key, review);
    else pending.delete(key);
    return review;
  }
  GitHubClient.prototype.createDraftReviewGraphQL = async (_nodeId, body, comments = [], existingReviewId, context) =>
    save(body, comments, existingReviewId, context, 'PENDING');
  GitHubClient.prototype.createReviewGraphQL = async (_nodeId, event, body, comments = [], existingReviewId, context) =>
    save(body, comments, existingReviewId, context,
      { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[event]);
}

module.exports = { installGitHubReviewMock };
