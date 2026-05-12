// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Fetch from a remote without auto-following tags reachable from the fetched
 * commits. Large monorepos can have very large tag namespaces, and pair-review
 * only needs commits/refs for review setup.
 * @param {Object} git - simple-git instance
 * @param {string[]} args - Arguments after `git fetch --no-tags`
 * @returns {Promise<*>}
 */
async function fetchNoTags(git, args) {
  return git.fetch(['--no-tags', ...args]);
}

/**
 * Raw `git fetch --no-tags` wrapper for fetch forms not exposed cleanly by
 * simple-git helpers.
 * @param {Object} git - simple-git instance
 * @param {string[]} args - Arguments after `git fetch --no-tags`
 * @returns {Promise<*>}
 */
async function rawFetchNoTags(git, args) {
  return git.raw(['fetch', '--no-tags', ...args]);
}

module.exports = {
  fetchNoTags,
  rawFetchNoTags,
};
