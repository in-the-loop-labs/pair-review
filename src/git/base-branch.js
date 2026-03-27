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
 *   1. Graphite — `gt trunk` and `gt parent`
 *   2. GitHub PR — look up an open PR for this branch
 *   3. Default branch — `git remote show origin` or local main/master
 *
 * @param {string} repoPath - Absolute path to the repository
 * @param {string} currentBranch - Current branch name (or 'HEAD' if detached)
 * @param {Object} [options]
 * @param {string} [options.repository] - owner/repo string (needed for GitHub lookup)
 * @param {boolean} [options.enableGraphite] - When true, try Graphite CLI for parent branch
 * @param {Object} [options._deps] - Dependency overrides for testing
 * @returns {Promise<{baseBranch: string, source: string, prNumber?: number}|null>}
 */
async function detectBaseBranch(repoPath, currentBranch, options = {}) {
  const deps = { ...defaults, ...options._deps };

  // Guard: detached HEAD — nothing to compare
  if (!currentBranch || currentBranch === 'HEAD') {
    return null;
  }

  // 1. Graphite (only when enabled via config)
  if (options.enableGraphite) {
    const graphiteResult = tryGraphite(repoPath, currentBranch, deps);
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
 * Try Graphite CLI to find the parent branch.
 */
function tryGraphite(repoPath, currentBranch, deps) {
  try {
    // Check if gt is installed
    deps.execSync('which gt', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000
    });

    // Get trunk branch
    const trunk = deps.execSync('gt trunk', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000
    }).trim();

    // Get parent branch
    const parent = deps.execSync('gt parent', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000
    }).trim();

    if (parent && parent !== currentBranch) {
      return { baseBranch: parent, source: 'graphite' };
    }

    // If parent is ourselves or empty, try trunk
    if (trunk && trunk !== currentBranch) {
      return { baseBranch: trunk, source: 'graphite' };
    }
  } catch {
    // Graphite not installed or failed — fall through silently
  }

  return null;
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
 * Synchronously detect the default branch for a repository.
 *
 * Uses the same logic as tryDefaultBranch but returns just the branch name
 * (or null). Suitable for call sites that need a quick, synchronous answer
 * without the full detectBaseBranch priority chain.
 *
 * @param {string} repoPath - Absolute path to the repository
 * @param {Object} [_deps] - Dependency overrides for testing
 * @returns {string|null} Default branch name, or null if it cannot be determined
 */
function getDefaultBranch(repoPath, _deps) {
  const deps = { ...defaults, ..._deps };

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
      if (branch && branch !== '(unknown)') {
        return branch;
      }
    }
  } catch {
    // No remote or network issue — try local refs
  }

  // Fallback: check if main or master exists locally
  for (const candidate of ['main', 'master']) {
    try {
      deps.execSync(`git rev-parse --verify ${candidate}`, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return candidate;
    } catch {
      // Branch doesn't exist
    }
  }

  return null;
}

module.exports = { detectBaseBranch, getDefaultBranch };
