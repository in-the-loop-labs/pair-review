// SPDX-License-Identifier: GPL-3.0-or-later
const { findGitRoot, getHeadSha, getCurrentBranch, getRepositoryName, generateLocalDiff, generateLocalReviewId, computeLocalDiffDigest, findMainGitRoot } = require('../local-review');
const { ReviewRepository, RepoSettingsRepository } = require('../database');
const { localReviewDiffs } = require('../routes/shared');
const path = require('path');
const fs = require('fs').promises;

/**
 * Orchestrate local review setup with progress callbacks.
 *
 * Each step reports { step, status, message } via onProgress so callers
 * (CLI, MCP, future GUI) can render progress however they choose.
 *
 * @param {Object} options
 * @param {Object} options.db - Initialized database instance
 * @param {string} options.targetPath - Path to review (file or directory)
 * @param {Function} [options.onProgress] - Progress callback ({ step, status, message })
 * @returns {Promise<Object>} Review session info
 */
async function setupLocalReview({ db, targetPath, onProgress }) {
  const progress = typeof onProgress === 'function'
    ? onProgress
    : () => {};

  // ── Step: validate ──────────────────────────────────────────────────
  let resolvedPath;
  try {
    progress({ step: 'validate', status: 'running', message: 'Validating target path...' });
    resolvedPath = path.resolve(targetPath);
    await fs.access(resolvedPath);
    progress({ step: 'validate', status: 'completed', message: `Path resolved to ${resolvedPath}` });
  } catch (err) {
    const message = `Path does not exist: ${path.resolve(targetPath)}`;
    progress({ step: 'validate', status: 'error', message });
    throw new Error(message);
  }

  // ── Step: git ───────────────────────────────────────────────────────
  let repoPath;
  try {
    progress({ step: 'git', status: 'running', message: 'Finding git repository root...' });
    repoPath = await findGitRoot(resolvedPath);
    progress({ step: 'git', status: 'completed', message: `Git root: ${repoPath}` });
  } catch (err) {
    progress({ step: 'git', status: 'error', message: err.message });
    throw err;
  }

  // ── Step: identity ──────────────────────────────────────────────────
  let headSha, branch, reviewId, existingReview, repository;
  try {
    progress({ step: 'identity', status: 'running', message: 'Reading repository identity...' });

    headSha = await getHeadSha(repoPath);
    branch = await getCurrentBranch(repoPath);
    reviewId = generateLocalReviewId(repoPath, headSha);

    const reviewRepo = new ReviewRepository(db);
    existingReview = await reviewRepo.getLocalReview(repoPath, headSha);

    repository = await getRepositoryName(repoPath);

    // Register local path for GitHub-connected repos (owner/repo format)
    if (repository.includes('/')) {
      try {
        const mainRepoRoot = await findMainGitRoot(repoPath);
        const repoSettingsRepo = new RepoSettingsRepository(db);
        await repoSettingsRepo.setLocalPath(repository, mainRepoRoot);
      } catch (_regErr) {
        // Non-fatal: registration failure should not block the review
      }
    }

    const identityMessage = existingReview
      ? `Existing session found (ID: ${existingReview.id}) for ${repository} on ${branch}`
      : `New session for ${repository} on ${branch} at ${headSha.substring(0, 8)}`;
    progress({ step: 'identity', status: 'completed', message: identityMessage });
  } catch (err) {
    progress({ step: 'identity', status: 'error', message: err.message });
    throw err;
  }

  // ── Step: diff ──────────────────────────────────────────────────────
  let diff, stats, digest;
  try {
    progress({ step: 'diff', status: 'running', message: 'Generating diff for local changes...' });

    const diffResult = await generateLocalDiff(repoPath);
    diff = diffResult.diff;
    stats = diffResult.stats;

    digest = await computeLocalDiffDigest(repoPath);

    progress({ step: 'diff', status: 'completed', message: `Diff ready: ${stats.unstagedChanges} unstaged, ${stats.untrackedFiles} untracked` });
  } catch (err) {
    progress({ step: 'diff', status: 'error', message: err.message });
    throw err;
  }

  // ── Step: store ─────────────────────────────────────────────────────
  let sessionId;
  try {
    progress({ step: 'store', status: 'running', message: 'Persisting review session...' });

    if (existingReview) {
      sessionId = existingReview.id;
    } else {
      const reviewRepo = new ReviewRepository(db);
      sessionId = await reviewRepo.upsertLocalReview({
        localPath: repoPath,
        localHeadSha: headSha,
        repository
      });
    }

    localReviewDiffs.set(sessionId, { diff, stats, digest });

    progress({ step: 'store', status: 'completed', message: `Review session ${sessionId} stored` });
  } catch (err) {
    progress({ step: 'store', status: 'error', message: err.message });
    throw err;
  }

  return {
    reviewId: sessionId,
    reviewUrl: '/local/' + sessionId,
    existing: !!existingReview,
    branch,
    repository,
    repoPath
  };
}

module.exports = { setupLocalReview };
