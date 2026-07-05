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
 * @param {string|null} [params.checkoutScript] - Repo's configured checkout script, if any. When set,
 *   the script owns all sparse-checkout setup, so built-in sparse-cone expansion is skipped (mirrors
 *   the non-stack `pr-setup.js` contract).
 * @returns {Promise<{ reviewId: number, prMetadata: Object, prData: Object, isNew: boolean }>}
 */
async function setupStackPR({ db, owner, repo, prNumber, githubToken, binding, bindingRepository, worktreePath, worktreeManager, prData: prefetchedPRData, checkoutScript }) {
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

  // 3. Expand sparse-checkout for PR-changed directories (mirrors pr-setup.js).
  // Stack worktrees inherit the trigger worktree's sparse-checkout layout, which
  // may omit directories a sibling PR touches. The SHA-based diff below reads
  // commit objects (not the working tree) so it is unaffected, but the later
  // file-context and codebase-context analysis steps DO read files from disk —
  // an unexpanded cone would silently under-review those files. Expanding here
  // ensures every PR-changed directory is present on disk.
  //
  // IMPORTANT: when a checkout_script is configured the script owns all
  // sparse-checkout setup, so we must NOT auto-expand — doing so would override
  // the cone the script just configured. This matches the pr-setup.js contract.
  if (!checkoutScript && prFiles.length > 0) {
    const isSparse = await worktreeManager.isSparseCheckoutEnabled(worktreePath);
    if (isSparse) {
      try {
        const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(worktreePath, prFiles);
        if (addedDirs.length > 0) {
          logger.info(`Stack PR #${prNumber}: expanded sparse-checkout for: ${addedDirs.join(', ')}`);
        }
      } catch (sparseError) {
        logger.warn(`Stack PR #${prNumber}: sparse-checkout expansion failed (non-fatal): ${sparseError.message}`);
      }
    }
  }

  // 4. Generate diff in the worktree (SHA-based, works after checkout)
  const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);

  // 5. Get changed files with stats
  const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

  // 6. Store via storePRData (creates/updates pr_metadata, reviews, worktrees records).
  // Stamp the host of the binding used to fetch this stack PR (null for
  // github.com, the api_host string for an alt host) so per-PR host resolution
  // self-heals across the stack. Omitted when only a bare token was supplied.
  const prInfo = { owner, repo, number: prNumber };
  const { isNewReview, reviewId } = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
    host: binding ? binding.host : undefined
  });

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
