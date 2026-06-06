// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stack PR Setup Utility
 *
 * Lightweight setup for individual PRs during stack analysis.
 * Fetches PR data (or accepts pre-fetched data), generates diffs,
 * and stores metadata via storePRData().
 */

const { storePRData } = require('./pr-setup');
const { GitHubClient } = require('../github/client');
const logger = require('../utils/logger');

/**
 * Set up a single PR within a stack analysis context.
 *
 * Fetches PR data from GitHub (or uses pre-fetched data when provided),
 * generates a diff in the worktree, and stores everything in the database
 * via storePRData().
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {number} params.prNumber - Pull request number
 * @param {string} [params.githubToken] - GitHub personal access token (legacy). Prefer `binding`.
 * @param {Object} [params.binding] - Resolved host binding (`resolveHostBinding(bindingRepository, config)`).
 *   Required for alt-host repos so the right API host is used.
 * @param {string} [params.bindingRepository] - `repos[...]` config-lookup key for this PR. Differs from
 *   `${owner}/${repo}` for monorepo `url_pattern` configs. Surfaced for downstream
 *   per-repo lookups (worktree pool, reset script) that key off the config entry.
 * @param {string} params.worktreePath - Path to the per-PR worktree
 * @param {import('../git/worktree').GitWorktreeManager} params.worktreeManager - Worktree manager instance
 * @param {Object} [params.prData] - Pre-fetched PR data from GitHub (skips API call when provided)
 * @returns {Promise<{ reviewId: number, prMetadata: Object, prData: Object, isNew: boolean }>}
 */
async function setupStackPR({ db, owner, repo, prNumber, githubToken, binding, bindingRepository, worktreePath, worktreeManager, prData: prefetchedPRData }) {
  // `bindingRepository` is accepted so callers (e.g. `executeStackAnalysis`)
  // can thread the resolved config-binding key through to any downstream
  // per-repo lookups added in this function. Currently unused inside this
  // function — `storePRData` keys off the PR identity.
  void bindingRepository;
  logger.info(`Setting up stack PR #${prNumber} for ${owner}/${repo}`);

  // 1. Fetch PR data from GitHub (or use pre-fetched data)
  const githubClient = new GitHubClient(binding || githubToken);
  let prData;
  if (prefetchedPRData) {
    prData = prefetchedPRData;
  } else {
    prData = await githubClient.fetchPullRequest(owner, repo, prNumber);
  }
  logger.info(`Fetched PR #${prNumber}: "${prData.title}"`);

  // 2. Fetch changed files list from GitHub API
  const prFiles = await githubClient.fetchPullRequestFiles(owner, repo, prNumber);
  logger.info(`PR #${prNumber} has ${prFiles.length} changed files`);

  // 3. Generate diff in the worktree (SHA-based, works after checkout)
  const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);

  // 4. Get changed files with stats
  const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

  // 5. Store via storePRData (creates/updates pr_metadata, reviews, worktrees records)
  const prInfo = { owner, repo, number: prNumber };
  const { isNewReview, reviewId } = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath);

  logger.info(`Stack PR #${prNumber} setup complete (reviewId: ${reviewId}, new: ${isNewReview})`);

  return {
    reviewId,
    prMetadata: {
      owner,
      repo,
      number: prNumber,
      title: prData.title,
      author: prData.author,
      base_branch: prData.base_branch,
      head_branch: prData.head_branch,
    },
    prData,
    isNew: isNewReview,
  };
}

module.exports = { setupStackPR };
