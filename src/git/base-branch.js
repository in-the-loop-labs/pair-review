// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { execSync } = require('child_process');
const logger = require('../utils/logger');

const defaults = {
  execSync,
  // Callers should pass a resolved token via _deps.getGitHubToken.
  // This default returns empty so GitHub lookup is silently skipped
  // when no token is provided — never re-resolve config internally.
  getGitHubToken: () => '',
  createGitHubClient: (token) => {
    const { GitHubClient } = require('../github/client');
    return new GitHubClient(token);
  }
};

/**
 * Detect the base branch for the current branch.
 *
 * Priority:
 *   1. Graphite — `gt state` (single call for trunk, parent, and stack)
 *   2. GitHub PR — look up an open PR for this branch
 *   3. Default branch — `git remote show origin` or local main/master
 *
 * @param {string} repoPath - Absolute path to the repository
 * @param {string} currentBranch - Current branch name (or 'HEAD' if detached)
 * @param {Object} [options]
 * @param {string} [options.repository] - owner/repo string (needed for GitHub lookup)
 * @param {boolean} [options.enableGraphite] - When true, try Graphite CLI for parent branch
 * @param {Object} [options._deps] - Dependency overrides for testing
 * @returns {Promise<{baseBranch: string, source: string, prNumber?: number, stack?: Array}|null>}
 */
async function detectBaseBranch(repoPath, currentBranch, options = {}) {
  const deps = { ...defaults, ...options._deps };

  // Guard: detached HEAD — nothing to compare
  if (!currentBranch || currentBranch === 'HEAD') {
    return null;
  }

  // 1. Graphite (only when enabled via config)
  if (options.enableGraphite) {
    const graphiteResult = tryGraphiteState(repoPath, currentBranch, deps);
    if (graphiteResult) return graphiteResult;
  }

  // 2. GitHub PR
  const ghResult = await tryGitHubPR(repoPath, currentBranch, options.repository, deps);
  if (ghResult) return ghResult;

  // 3. Default branch
  const defaultResult = tryDefaultBranch(repoPath, currentBranch, deps);
  if (defaultResult) return defaultResult;

  return null;
}

/**
 * Try Graphite CLI `gt state` to find the parent branch and build the stack.
 * Single execSync call replaces the previous 3 serial calls.
 */
function tryGraphiteState(repoPath, currentBranch, deps) {
  try {
    const raw = deps.execSync('gt state', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });

    const state = JSON.parse(raw);
    const trunk = Object.entries(state).find(([, v]) => v.trunk)?.[0];
    const entry = state[currentBranch];
    const parent = entry?.parents?.[0]?.ref;

    if (!entry || !parent || parent === currentBranch) {
      return null;
    }

    const stack = buildStack(state, currentBranch, trunk);
    return { baseBranch: parent, source: 'graphite', stack };
  } catch (error) {
    logger.debug(`Graphite state failed: ${error.message}`);
  }

  return null;
}

/**
 * Walk from currentBranch up via parents[0].ref to build the stack,
 * ordered trunk-first. Includes cycle protection.
 *
 * @param {Object} state - Parsed `gt state` output
 * @param {string} currentBranch - Current branch name
 * @param {string|undefined} trunk - Trunk branch name
 * @returns {Array<{branch: string, parentBranch: string|null, parentSha: string|null, isTrunk: boolean}>}
 */
function buildStack(state, currentBranch, trunk) {
  const entries = [];
  const visited = new Set();
  let branch = currentBranch;

  while (branch && !visited.has(branch)) {
    visited.add(branch);
    const info = state[branch];
    if (!info) break;

    const parentRef = info.parents?.[0]?.ref || null;
    const parentSha = info.parents?.[0]?.sha || null;
    entries.push({
      branch,
      parentBranch: parentRef,
      parentSha,
      isTrunk: !!info.trunk
    });

    branch = parentRef;
  }

  entries.reverse();

  // If the walk terminated before reaching the trunk, prepend it
  if (trunk && !visited.has(trunk) && state[trunk]) {
    entries.unshift({
      branch: trunk,
      parentBranch: null,
      parentSha: null,
      isTrunk: true
    });
  }

  return entries;
}

/**
 * Try GitHub API to find an open PR for this branch.
 */
async function tryGitHubPR(repoPath, currentBranch, repository, deps) {
  if (!repository || !repository.includes('/')) return null;

  try {
    const token = deps.getGitHubToken();
    if (!token) return null;

    const [owner, repo] = repository.split('/');
    const client = deps.createGitHubClient(token);
    const result = await client.findPRByBranch(owner, repo, currentBranch);

    if (result) {
      // Guard: base branch same as current branch (shouldn't happen but be safe)
      if (result.baseBranch === currentBranch) return null;
      return {
        baseBranch: result.baseBranch,
        source: 'github-pr',
        prNumber: result.prNumber
      };
    }
  } catch (error) {
    logger.warn(`GitHub PR lookup failed: ${error.message}`);
  }

  return null;
}

/**
 * Try to determine the default branch from git remote or local refs.
 */
function tryDefaultBranch(repoPath, currentBranch, deps) {
  // Try `git remote show origin`
  try {
    const output = deps.execSync('git remote show origin', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });

    const match = output.match(/HEAD branch:\s*(.+)/);
    if (match) {
      const branch = match[1].trim();
      if (branch && branch !== currentBranch && branch !== '(unknown)') {
        return { baseBranch: branch, source: 'default-branch' };
      }
    }
  } catch {
    // No remote or network issue — try local refs
  }

  // Fallback: check if main or master exists locally
  for (const candidate of ['main', 'master']) {
    if (candidate === currentBranch) continue;
    try {
      deps.execSync(`git rev-parse --verify ${candidate}`, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return { baseBranch: candidate, source: 'default-branch' };
    } catch {
      // Branch doesn't exist
    }
  }

  return null;
}

/**
 * Synchronously detect the default branch for a repository using only
 * local refs (no network I/O).
 *
 * Priority:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — reads the local ref
 *      that `git clone` sets automatically.
 *   2. Check whether `refs/heads/main` or `refs/heads/master` exist locally.
 *
 * @param {string} localPath - Absolute path to the repository
 * @param {Object} [_deps] - Dependency overrides for testing
 * @returns {string|null} Default branch name, or null if it cannot be determined
 */
function getDefaultBranch(localPath, _deps) {
  if (!localPath) return null;
  const deps = { ...defaults, ..._deps };

  // Try symbolic-ref (set by git clone)
  try {
    const ref = deps.execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: localPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // ref looks like "refs/remotes/origin/main"
    const branch = ref.replace(/^refs\/remotes\/origin\//, '');
    if (branch && branch !== ref) return branch;
  } catch {
    // origin/HEAD not set — fall through to local check
  }

  // Fallback: check if main or master exists locally
  for (const candidate of ['main', 'master']) {
    try {
      deps.execSync(`git rev-parse --verify refs/heads/${candidate}`, {
        cwd: localPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return candidate;
    } catch {
      // Branch doesn't exist
    }
  }

  return null;
}

module.exports = { detectBaseBranch, getDefaultBranch, tryGraphiteState, buildStack };
