// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stack PR Setup Utility
 *
 * Lightweight setup for individual PRs during stack analysis.
 * Runs AFTER checkoutBranch() has already placed the correct branch
 * in the shared worktree, so all SHAs are available for diff generation.
 *
 * Reuses storePRData() from pr-setup.js for database persistence.
 */

const { storePRData } = require('./pr-setup');
const { GitHubClient } = require('../github/client');
const logger = require('../utils/logger');

/**
 * Set up a single PR within a stack analysis context.
 *
 * Fetches PR data from GitHub, generates a diff in the (already checked-out)
 * worktree, and stores everything in the database via storePRData().
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {number} params.prNumber - Pull request number
 * @param {string} params.githubToken - GitHub personal access token
 * @param {string} params.worktreePath - Path to the shared worktree (already checked out to this PR)
 * @param {import('../git/worktree').GitWorktreeManager} params.worktreeManager - Worktree manager instance
 * @returns {Promise<{ reviewId: number, prMetadata: Object, prData: Object, isNew: boolean }>}
 */
async function setupStackPR({ db, owner, repo, prNumber, githubToken, worktreePath, worktreeManager }) {
  logger.info(`Setting up stack PR #${prNumber} for ${owner}/${repo}`);

  // 1. Fetch PR data from GitHub
  const githubClient = new GitHubClient(githubToken);
  const prData = await githubClient.fetchPullRequest(owner, repo, prNumber);
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
