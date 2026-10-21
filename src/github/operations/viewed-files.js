// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const DEFAULT_BATCH_SIZE = 50;

/**
 * @param {Object} octokit - Octokit instance bound to the configured host
 * @param {string|null} apiHost - null for github.com, otherwise an alt host
 * @param {string} prNodeId - GraphQL node ID for the pull request
 * @param {Array} paths - File paths to mark as viewed
 * @returns {Promise<void>}
 */
async function markFilesAsViewed(octokit, apiHost, prNodeId, paths) {
  if (apiHost || !prNodeId || !Array.isArray(paths) || paths.length === 0) return;

  for (let offset = 0; offset < paths.length; offset += DEFAULT_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + DEFAULT_BATCH_SIZE);
    const pathVariables = batch.map((_, index) => `$path${index}: String!`).join(', ');
    const mutations = batch.map((_, index) => `
      file${index}: markFileAsViewed(input: {
        pullRequestId: $pullRequestId
        path: $path${index}
      }) {
        pullRequest { id }
      }
    `).join('\n');
    const variables = { pullRequestId: prNodeId };

    batch.forEach((path, index) => {
      variables[`path${index}`] = path;
    });

    await octokit.graphql(`
      mutation MarkFilesAsViewed($pullRequestId: ID!, ${pathVariables}) {
        ${mutations}
      }
    `, variables);
  }
}

module.exports = {
  markFilesAsViewed,
  DEFAULT_BATCH_SIZE
};
