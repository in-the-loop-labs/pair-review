// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('../utils/logger');

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

/**
 * Detect whether a fetch failed because a remote-tracking ref collides with the
 * ref hierarchy (a directory/file conflict, e.g. `refs/remotes/origin/foo`
 * exists as a ref while `refs/remotes/origin/foo/bar` needs to be created).
 *
 * `cannot lock ref` on its own is too broad: git emits it for transient
 * lock-file races too ("cannot lock ref 'X': Unable to create '….lock': File
 * exists"), which pruning cannot fix and which would waste a full prune + refetch.
 * A genuine D/F conflict names the colliding ref in quotes — "'refs/remotes/
 * origin/foo' exists" — so require that quoted-ref " exists" clause alongside it.
 *
 * @param {Error} error
 * @returns {boolean}
 */
function isRefHierarchyConflict(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('exists; cannot create')) return true;
  if (message.includes('would clobber existing tag')) return true;
  return message.includes('cannot lock ref') && message.includes("' exists");
}

/**
 * Fetch a single refspec from a remote, recovering once from ref hierarchy
 * conflicts by pruning stale remote-tracking refs and retrying.
 *
 * `git remote prune` is used rather than `git fetch --prune` on purpose: it
 * deletes stale remote-tracking refs without downloading anything, so the
 * recovery path stays cheap on large monorepos.
 *
 * @param {Object} git - simple-git instance
 * @param {string} remote - Remote name
 * @param {string} refspec - Refspec to fetch
 * @returns {Promise<*>}
 */
async function fetchWithPruneRecovery(git, remote, refspec) {
  try {
    return await fetchNoTags(git, [remote, refspec]);
  } catch (error) {
    if (!isRefHierarchyConflict(error)) throw error;
    logger.info(`Ref hierarchy conflict fetching ${refspec} from ${remote}, pruning stale remote-tracking refs and retrying: ${error.message}`);
    await git.raw(['remote', 'prune', remote]);
    return fetchNoTags(git, [remote, refspec]);
  }
}

module.exports = {
  fetchNoTags,
  rawFetchNoTags,
  isRefHierarchyConflict,
  fetchWithPruneRecovery,
};
