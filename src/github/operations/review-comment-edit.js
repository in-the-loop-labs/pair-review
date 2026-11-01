// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const graphqlImpl = require('../impl/graphql/review-comment-edit');
const restImpl = require('../impl/rest/review-comment-edit');
const hostImpl = require('../impl/host/review-comment-edit');

const AREA = 'review_comment_edit';
const IMPLEMENTED_MODES = new Set(['graphql', 'rest', 'host']);

async function dispatch(method, octokit, features, ref, body) {
  const mode = features?.[AREA] || 'graphql';
  try {
    if (mode === 'graphql') return await graphqlImpl[method](octokit, ref, body);
    if (mode === 'rest') return await restImpl[method](octokit, ref, body);
    if (mode === 'host') return await hostImpl[method](octokit, features, ref, body);
    throw new Error(`Unknown features.${AREA} value: "${mode}"`);
  } catch (error) {
    const types = (error.errors || []).map(item => item.type ?? item.extensions?.code);
    const status = error.status ?? error.response?.status;
    // Octokit's legacy `code` can be the numeric HTTP status; never let it
    // override the stable operation codes (and avoid that deprecated getter).
    const code = status === 404 || types.includes('NOT_FOUND') ? 'not_found' :
      status === 403 || status === 422 || types.some(type => ['FORBIDDEN', 'UNPROCESSABLE', 'UNPROCESSABLE_ENTITY'].includes(type)) ? 'forbidden' :
        status ? undefined : error.code;
    const wrapped = new Error(`${method} (${mode}): ${error.message}`, { cause: error });
    if (code) wrapped.code = code;
    if (status) wrapped.status = status;
    throw wrapped;
  }
}

module.exports = {
  AREA, IMPLEMENTED_MODES,
  updateReviewComment: (octokit, features, ref, body) => dispatch('updateReviewComment', octokit, features, ref, body),
  listCommentsForReview: (octokit, features, ref) => dispatch('listCommentsForReview', octokit, features, ref)
};
