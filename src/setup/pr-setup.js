// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * PR Setup Orchestrator
 *
 * Consolidates PR setup logic (previously duplicated across main.js and
 * routes/worktrees.js) into a reusable module. Covers:
 *   - storePRData: transactional database storage for PR metadata + reviews
 *   - registerRepositoryLocation: persist known repo paths for future sessions
 *   - findRepositoryPath: tiered repository discovery (known path -> existing
 *     worktree -> cached clone -> fresh clone)
 *   - setupPRReview: full orchestrator that wires the above together
 */

const { run, queryOne, WorktreeRepository, RepoSettingsRepository } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { normalizeRepository } = require('../utils/paths');
const { findMainGitRoot } = require('../local-review');
const { getConfigDir, loadConfig, getMonorepoPath } = require('../config');
const logger = require('../utils/logger');
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

/**
 * Store PR data in the database within a single transaction.
 *
 * Creates or updates pr_metadata and reviews rows, and optionally records the
 * worktree path via WorktreeRepository.
 *
 * @param {Object} db - Database instance
 * @param {Object} prInfo - PR information { owner, repo, number }
 * @param {Object} prData - PR data from GitHub API
 * @param {string} diff - Unified diff content
 * @param {Array} changedFiles - Changed files information
 * @param {string} worktreePath - Worktree (or checkout) path
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.skipWorktreeRecord] - Skip creating a worktree DB record
 */
async function storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, options = {}) {
  const repository = normalizeRepository(prInfo.owner, prInfo.repo);

  // Begin transaction for atomic database operations
  await run(db, 'BEGIN TRANSACTION');

  try {
    // Store or update worktree record (skip when using --use-checkout,
    // since the path is the user's working directory, not a managed worktree)
    if (!options.skipWorktreeRecord) {
      const worktreeRepo = new WorktreeRepository(db);
      await worktreeRepo.getOrCreate({
        prNumber: prInfo.number,
        repository,
        branch: prData.head_branch,
        path: worktreePath
      });
    }

    // Prepare extended PR data (keep worktree_path for backward compat, but DB is source of truth)
    const extendedPRData = {
      ...prData,
      diff: diff,
      changed_files: changedFiles,
      worktree_path: worktreePath,
      fetched_at: new Date().toISOString()
    };

    // First check if PR metadata exists
    const existingPR = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    if (existingPR) {
      // Update existing PR metadata (preserves ID)
      await run(db, `
        UPDATE pr_metadata
        SET title = ?, description = ?, author = ?,
            base_branch = ?, head_branch = ?, pr_data = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData),
        existingPR.id
      ]);
      logger.info(`Updated existing PR metadata (ID: ${existingPR.id})`);
    } else {
      // Insert new PR metadata
      const result = await run(db, `
        INSERT INTO pr_metadata
        (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        prInfo.number,
        repository,
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData)
      ]);
      logger.info(`Created new PR metadata (ID: ${result.lastID})`);
    }

    // Create or update review record
    // NOTE: Uses raw SQL instead of ReviewRepository to participate in the surrounding
    // transaction and to update only review_data without overwriting custom_instructions
    // or summary fields that may have been set by previous analysis runs.
    const existingReview = await queryOne(db, `
      SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    if (existingReview) {
      // Update existing review (preserves ID)
      await run(db, `
        UPDATE reviews
        SET review_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        }),
        existingReview.id
      ]);
      logger.info(`Updated existing review (ID: ${existingReview.id})`);
    } else {
      // Insert new review
      const result = await run(db, `
        INSERT INTO reviews
        (pr_number, repository, status, review_data)
        VALUES (?, ?, 'draft', ?)
      `, [
        prInfo.number,
        repository,
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        })
      ]);
      logger.info(`Created new review (ID: ${result.lastID})`);
    }

    // Commit transaction
    await run(db, 'COMMIT');
    logger.info(`Stored PR data for ${repository} #${prInfo.number}`);

  } catch (error) {
    // Rollback transaction on error
    await run(db, 'ROLLBACK');
    logger.error('Error storing PR data:', error);
    throw new Error(`Failed to store PR data: ${error.message}`);
  }
}

/**
 * Register the known location of a GitHub repository in the database.
 * This allows the web UI to find the repo without cloning when reviewing PRs.
 *
 * @param {Object} db - Database instance
 * @param {string} currentDir - Current working directory (or any directory in the repo)
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<void>}
 */
async function registerRepositoryLocation(db, currentDir, owner, repo) {
  const repository = normalizeRepository(owner, repo);
  try {
    // Use findMainGitRoot to resolve worktrees to their parent repo
    // This ensures we always store the actual git root, not a worktree path
    const gitRoot = await findMainGitRoot(currentDir);
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath(repository, gitRoot);
    console.log(`Registered repository location: ${gitRoot}`);
  } catch (error) {
    // Non-fatal: registration failure shouldn't block the review
    console.warn(`Could not register repository location: ${error.message}`);
  }
}

/**
 * Tiered repository discovery: find a usable local git repository for the
 * given owner/repo so that worktrees can be created from it.
 *
 * Tiers (in order of preference):
 *  -1. Explicit monorepo configuration (highest priority)
 *   0. Known local path from repo_settings (registered by CLI or previous web UI)
 *   1. Existing worktree for this repo (derive parent git root from it)
 *   2. Cached clone at <configDir>/repos/<owner>/<repo>
 *   3. Fresh clone to the cached location above
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.repository - Normalized "owner/repo" string
 * @param {number} params.prNumber - PR number (used for worktree lookup)
 * @param {Function} [params.onProgress] - Optional progress callback
 * @returns {Promise<{ repositoryPath: string, knownPath: string|null, worktreeSourcePath: string|null }>}
 *   - repositoryPath: the main git root (bare repo or .git parent)
 *   - knownPath: the known path from database (if any)
 *   - worktreeSourcePath: path to use as cwd for `git worktree add` (may be a worktree with sparse-checkout)
 */
async function findRepositoryPath({ db, owner, repo, repository, prNumber, onProgress }) {
  const worktreeManager = new GitWorktreeManager(db);
  const repoSettingsRepo = new RepoSettingsRepository(db);
  const worktreeRepo = new WorktreeRepository(db);

  let repositoryPath = null;
  let worktreeSourcePath = null;  // Path to use as cwd for `git worktree add` (may differ from repositoryPath)

  // ------------------------------------------------------------------
  // Tier -1: Explicit monorepo configuration (highest priority)
  // ------------------------------------------------------------------
  const { config } = await loadConfig();
  const monorepoPath = getMonorepoPath(config, repository);

  if (monorepoPath) {
    // The configured path might be a worktree or a regular/bare repo.
    // We need the main git root for creating new worktrees, but we also want to
    // preserve the original path if it's a worktree so sparse-checkout is inherited.
    // Wrap in try-catch since findMainGitRoot throws if path doesn't exist or isn't a git repo
    try {
      const resolvedPath = await findMainGitRoot(monorepoPath);
      logger.debug(`Monorepo path ${monorepoPath} resolved to ${resolvedPath}`);

      // Check if this is a valid git directory we can create worktrees from.
      // It could be:
      // 1. A regular repo (has .git directory)
      // 2. A bare repo (is itself a git directory with HEAD, objects, refs)
      // 3. A worktree (has .git file pointing to actual git dir)
      const gitDirPath = path.join(resolvedPath, '.git');
      const headPath = path.join(resolvedPath, 'HEAD');

      const hasGitDir = await worktreeManager.pathExists(gitDirPath);
      const hasHead = await worktreeManager.pathExists(headPath);

      if (hasGitDir || hasHead) {
        // Verify we can actually run git commands here
        try {
          const git = simpleGit(resolvedPath);
          await git.revparse(['HEAD']);
          repositoryPath = resolvedPath;

          // If the configured path differs from the resolved path, it's likely a worktree.
          // Use the original configured path as the source for worktree creation so
          // sparse-checkout configuration is inherited.
          if (monorepoPath !== resolvedPath) {
            worktreeSourcePath = monorepoPath;
            logger.info(`Using configured monorepo path at ${repositoryPath} (worktree source: ${worktreeSourcePath})`);
          } else {
            logger.info(`Using configured monorepo path at ${repositoryPath}`);
          }
        } catch (gitError) {
          logger.warn(`Configured monorepo path ${monorepoPath} resolved to ${resolvedPath} but git commands fail: ${gitError.message}`);
        }
      } else {
        logger.warn(`Configured monorepo path ${monorepoPath} resolved to ${resolvedPath} which has no .git directory or HEAD file`);
      }
    } catch (resolveError) {
      logger.warn(`Configured monorepo path ${monorepoPath} does not exist or is not a git repository: ${resolveError.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Tier 0: Check known local path from repo_settings
  // ------------------------------------------------------------------
  const knownPath = await repoSettingsRepo.getLocalPath(repository);

  if (!repositoryPath && knownPath && await worktreeManager.pathExists(knownPath)) {
    try {
      const git = simpleGit(knownPath);
      // Use --git-dir instead of --is-inside-work-tree to support bare repos
      await git.revparse(['--git-dir']);
      repositoryPath = knownPath;
      logger.info(`Using known repository location at ${repositoryPath}`);
    } catch {
      // Path exists but isn't a valid git repo anymore, clear it
      logger.warn(`Known path ${knownPath} is no longer a valid git repo, clearing`);
      await repoSettingsRepo.setLocalPath(repository, null);
    }
  }

  // ------------------------------------------------------------------
  // Tier 1: Check existing worktree for this repo
  // ------------------------------------------------------------------
  if (!repositoryPath) {
    const existingWorktree = await worktreeRepo.findByPR(prNumber, repository);

    if (existingWorktree && await worktreeManager.pathExists(existingWorktree.path)) {
      try {
        const git = simpleGit(existingWorktree.path);
        repositoryPath = await git.revparse(['--show-toplevel']);
        repositoryPath = repositoryPath.trim();
        logger.info(`Using repository from existing worktree at ${repositoryPath}`);
      } catch {
        // If we can't get the git root, we'll need to clone
        repositoryPath = null;
      }
    }
  }

  // ------------------------------------------------------------------
  // Tier 2: Check cached clone at <configDir>/repos/<owner>/<repo>
  // ------------------------------------------------------------------
  if (!repositoryPath) {
    const cachedRepoPath = path.join(getConfigDir(), 'repos', owner, repo);

    if (await worktreeManager.pathExists(cachedRepoPath)) {
      repositoryPath = cachedRepoPath;
      logger.info(`Using cached repository at ${repositoryPath}`);
    } else {
      // ----------------------------------------------------------------
      // Tier 3: Clone fresh to cached location
      // ----------------------------------------------------------------
      if (onProgress) {
        onProgress({ step: 'repo', status: 'running', message: `Cloning repository ${repository}...` });
      }
      logger.info(`Cloning repository ${repository}...`);
      await fs.mkdir(path.dirname(cachedRepoPath), { recursive: true });

      const git = simpleGit();
      const cloneUrl = `https://github.com/${owner}/${repo}.git`;
      await git.clone(cloneUrl, cachedRepoPath, ['--filter=blob:none', '--no-checkout']);
      repositoryPath = cachedRepoPath;
      if (onProgress) {
        onProgress({ step: 'repo', status: 'running', message: `Repository cloned to ${cachedRepoPath}` });
      }
      logger.info(`Cloned repository to ${repositoryPath}`);
    }
  }

  return { repositoryPath, knownPath, worktreeSourcePath };
}

/**
 * Full PR review setup orchestrator.
 *
 * Verifies repository access, fetches PR data, discovers (or clones) the
 * local repository, creates a worktree, generates a diff, and stores
 * everything in the database.
 *
 * @param {Object} params
 * @param {Object} params.db - Database instance
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {number} params.prNumber - Pull request number
 * @param {string} params.githubToken - GitHub PAT
 * @param {Function} [params.onProgress] - Optional progress callback
 * @returns {Promise<{ reviewUrl: string, title: string }>}
 */
async function setupPRReview({ db, owner, repo, prNumber, githubToken, onProgress }) {
  const repository = normalizeRepository(owner, repo);
  const progress = onProgress || (() => {});

  // ------------------------------------------------------------------
  // Step: verify - Verify repository access
  // ------------------------------------------------------------------
  progress({ step: 'verify', status: 'running', message: 'Verifying repository access...' });
  const githubClient = new GitHubClient(githubToken);
  const repoExists = await githubClient.repositoryExists(owner, repo);
  if (!repoExists) {
    throw new Error(`Repository ${owner}/${repo} not found`);
  }
  progress({ step: 'verify', status: 'completed', message: 'Repository access verified.' });

  // ------------------------------------------------------------------
  // Step: fetch - Fetch PR data from GitHub
  // ------------------------------------------------------------------
  progress({ step: 'fetch', status: 'running', message: 'Fetching pull request data from GitHub...' });
  const prData = await githubClient.fetchPullRequest(owner, repo, prNumber);
  progress({ step: 'fetch', status: 'completed', message: 'Pull request data fetched.' });

  // ------------------------------------------------------------------
  // Step: repo - Find (or clone) a local repository
  // ------------------------------------------------------------------
  progress({ step: 'repo', status: 'running', message: 'Locating repository...' });
  const { repositoryPath, knownPath, worktreeSourcePath } = await findRepositoryPath({
    db,
    owner,
    repo,
    repository,
    prNumber,
    onProgress: progress
  });
  progress({ step: 'repo', status: 'completed', message: `Repository located at ${repositoryPath}` });

  // ------------------------------------------------------------------
  // Step: worktree - Create git worktree for the PR
  // ------------------------------------------------------------------
  progress({ step: 'worktree', status: 'running', message: 'Setting up git worktree...' });
  const worktreeManager = new GitWorktreeManager(db);
  const prInfo = { owner, repo, number: prNumber };
  // Use worktreeSourcePath as cwd for git worktree add (if available) to inherit sparse-checkout
  const worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, repositoryPath, { worktreeSourcePath });
  progress({ step: 'worktree', status: 'completed', message: `Worktree created at ${worktreePath}` });

  // ------------------------------------------------------------------
  // Step: sparse - Expand sparse-checkout before generating diff
  // ------------------------------------------------------------------
  // IMPORTANT: Sparse-checkout expansion MUST happen before diff generation.
  // In monorepo worktrees that inherit a sparse-checkout from the source
  // worktree, the checkout may not include all directories touched by the PR.
  // If we generate the diff first, files outside the sparse cone will be missing
  // from the worktree, producing an incomplete or empty diff. Expanding the
  // sparse-checkout ensures every PR-changed directory is present on disk so
  // that `git diff` can read the actual file contents.
  //
  if (prData.changed_files && prData.changed_files.length > 0) {
    const addedDirs = await worktreeManager.ensurePRDirectoriesInSparseCheckout(worktreePath, prData.changed_files);
    if (addedDirs.length > 0) {
      logger.info(`Expanded sparse-checkout for PR directories: ${addedDirs.join(', ')}`);
    }
  }

  // ------------------------------------------------------------------
  // Step: diff - Generate unified diff and changed file list
  // ------------------------------------------------------------------
  progress({ step: 'diff', status: 'running', message: 'Generating unified diff...' });
  const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
  const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);
  progress({ step: 'diff', status: 'completed', message: 'Diff generated.' });

  // ------------------------------------------------------------------
  // Step: store - Persist PR data and register repository location
  // ------------------------------------------------------------------
  progress({ step: 'store', status: 'running', message: 'Storing pull request data...' });
  await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath);

  // Register the repository path for future sessions if it wasn't already known
  if (knownPath === null && repositoryPath) {
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const currentPath = await repoSettingsRepo.getLocalPath(repository);
    if (path.resolve(currentPath || '') !== path.resolve(repositoryPath)) {
      await repoSettingsRepo.setLocalPath(repository, repositoryPath);
      logger.info(`Registered repository location: ${repositoryPath}`);
    }
  }
  progress({ step: 'store', status: 'completed', message: 'Pull request data stored.' });

  // ------------------------------------------------------------------
  // Return the review URL and title for the caller
  // ------------------------------------------------------------------
  const reviewUrl = `/pr/${owner}/${repo}/${prNumber}`;
  return { reviewUrl, title: prData.title };
}

module.exports = { setupPRReview, storePRData, registerRepositoryLocation, findRepositoryPath };
