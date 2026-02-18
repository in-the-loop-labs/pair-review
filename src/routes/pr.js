// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Core PR Routes
 *
 * Handles core PR data endpoints:
 * - Get PR data
 * - Refresh PR data from GitHub
 * - Get PR list
 * - Get PR diff
 * - Get PR comments
 * - Get file content (for context expansion)
 * - Submit review to GitHub
 * - Health check
 */

const express = require('express');
const { query, queryOne, run, withTransaction, WorktreeRepository, ReviewRepository, GitHubReviewRepository, RepoSettingsRepository, AnalysisRunRepository, PRMetadataRepository, CouncilRepository } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { getGeneratedFilePatterns } = require('../git/gitattributes');
const { normalizeRepository } = require('../utils/paths');
const { mergeInstructions } = require('../utils/instructions');
const Analyzer = require('../ai/analyzer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const simpleGit = require('simple-git');
const {
  activeAnalyses,
  reviewToAnalysisId,
  getModel,
  determineCompletionInfo,
  broadcastProgress,
  createProgressCallback,
  parseEnabledLevels
} = require('./shared');
const { validateCouncilConfig, normalizeCouncilConfig } = require('./councils');
const analysesRouter = require('./analyses');

const router = express.Router();

/**
 * Sync pending draft review from GitHub with local database
 *
 * Handles three scenarios:
 * 1. Same draft updated - The draft we know about has been updated on GitHub. Update our record.
 * 2. NEW draft created outside pair-review - A new draft was created on GitHub (e.g., user
 *    started a review directly on GitHub). Create a new record and query GitHub for the actual
 *    state of old pending records (submitted or dismissed).
 * 3. No GitHub draft but we have pending records - Those drafts were dismissed/submitted
 *    outside pair-review (handled by caller, not this function).
 *
 * @param {GitHubReviewRepository} githubReviewRepo - The GitHub review repository
 * @param {number} reviewId - The local review ID
 * @param {Object} githubPendingReview - The pending review data from GitHub GraphQL API
 * @param {GitHubClient} [githubClient] - Optional GitHub client for querying old review states
 * @returns {Promise<Object>} The synced pending draft record with comments_count
 */
async function syncPendingDraftFromGitHub(githubReviewRepo, reviewId, githubPendingReview, githubClient = null) {
  // Find all our pending records for this review
  const existingPendingRecords = await githubReviewRepo.findPendingByReviewId(reviewId);

  // Check if this GitHub draft matches any of our records by node_id
  const matchingRecord = existingPendingRecords.find(
    r => r.github_node_id === githubPendingReview.id
  );

  let pendingDraft;
  if (matchingRecord) {
    // Same draft - update it with latest data from GitHub
    await githubReviewRepo.update(matchingRecord.id, {
      github_review_id: String(githubPendingReview.databaseId),
      github_url: githubPendingReview.url,
      body: githubPendingReview.body,
      state: 'pending'
    });
    pendingDraft = await githubReviewRepo.getById(matchingRecord.id);
  } else {
    // New draft from GitHub - create new record
    // Query GitHub for the actual state of old pending records
    for (const oldRecord of existingPendingRecords) {
      let actualState = 'dismissed'; // Default if we can't determine
      let githubReviewData = null;

      if (githubClient && oldRecord.github_node_id) {
        try {
          githubReviewData = await githubClient.getReviewById(oldRecord.github_node_id);

          if (githubReviewData) {
            // Map GitHub state to our local state
            // GitHub states: PENDING, APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
            // Our states: local, pending, submitted, dismissed
            if (githubReviewData.state === 'PENDING') {
              // This shouldn't happen (we have a different pending review now), but handle it
              actualState = 'pending';
            } else if (githubReviewData.state === 'DISMISSED') {
              actualState = 'dismissed';
            } else {
              // APPROVED, CHANGES_REQUESTED, COMMENTED all mean it was submitted
              actualState = 'submitted';
            }
            logger.debug(`Old review ${oldRecord.github_node_id} actual state from GitHub: ${githubReviewData.state} -> ${actualState}`);
          } else {
            // Review not found on GitHub - treat as dismissed
            logger.debug(`Old review ${oldRecord.github_node_id} not found on GitHub, marking as dismissed`);
            actualState = 'dismissed';
          }
        } catch (error) {
          // On error, default to dismissed (most likely scenario)
          logger.warn(`Error querying GitHub for old review ${oldRecord.github_node_id}: ${error.message}, marking as dismissed`);
          actualState = 'dismissed';
        }
      }

      // Update the old record with the actual state and submitted_at if available
      const updateData = { state: actualState };
      if (actualState === 'submitted' && githubReviewData?.submittedAt) {
        updateData.submitted_at = githubReviewData.submittedAt;
      }
      await githubReviewRepo.update(oldRecord.id, updateData);
    }

    pendingDraft = await githubReviewRepo.create(reviewId, {
      github_review_id: String(githubPendingReview.databaseId),
      github_node_id: githubPendingReview.id,
      github_url: githubPendingReview.url,
      body: githubPendingReview.body,
      state: 'pending'
    });
  }

  pendingDraft.comments_count = githubPendingReview.comments?.totalCount || 0;
  return pendingDraft;
}

/**
 * Get pull request data by owner, repo, and number
 */
router.get('/api/pr/:owner/:repo/:number', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);

    // Get PR metadata from database
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT
        id,
        pr_number,
        repository,
        title,
        description,
        author,
        base_branch,
        head_branch,
        created_at,
        updated_at,
        pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found in repository ${repository}`
      });
    }

    // Get review record if it exists (don't create on GET - REST compliance)
    // The review.id is used for comments to avoid ID collision with local mode
    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    // Parse extended PR data
    let extendedData = {};
    try {
      extendedData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Parse owner and repo from repository field
    const [repoOwner, repoName] = repository.split('/');

    // Check for pending GitHub draft if we have a review record
    // This avoids unnecessary GitHub API calls for PRs the user hasn't started reviewing
    let pendingDraft = null;
    if (review) {
      const config = req.app.get('config');
      const githubToken = config?.github_token || req.app.get('githubToken');

      if (githubToken) {
        try {
          const githubClient = new GitHubClient(githubToken);
          const githubReviewRepo = new GitHubReviewRepository(db);

          const githubPendingReview = await githubClient.getPendingReviewForUser(repoOwner, repoName, prNumber);

          if (githubPendingReview) {
            pendingDraft = await syncPendingDraftFromGitHub(githubReviewRepo, review.id, githubPendingReview, githubClient);
          }
        } catch (githubError) {
          // Log the error but don't fail the request - draft info is supplementary
          logger.warn('Failed to fetch pending review from GitHub:', githubError.message);
        }
      }
    }

    // Prepare response
    // Use review.id instead of prMetadata.id to avoid ID collision with local mode
    // When no review exists yet, id will be null
    const response = {
      success: true,
      data: {
        id: review ? review.id : null,
        owner: repoOwner,
        repo: repoName,
        number: prMetadata.pr_number,
        title: prMetadata.title,
        body: prMetadata.description,
        author: prMetadata.author,
        state: extendedData.state || 'open',
        base_branch: prMetadata.base_branch,
        head_branch: prMetadata.head_branch,
        head_sha: extendedData.head_sha || null,  // Head commit SHA for GitHub API comments
        node_id: extendedData.node_id || null,  // GraphQL node ID for review submission
        created_at: prMetadata.created_at,
        updated_at: prMetadata.updated_at,
        file_changes: extendedData.changed_files ? extendedData.changed_files.length : 0,
        changed_files: extendedData.changed_files || [],
        additions: extendedData.additions || 0,
        deletions: extendedData.deletions || 0,
        diff_content: extendedData.diff || '',
        html_url: extendedData.html_url || `https://github.com/${repoOwner}/${repoName}/pull/${prMetadata.pr_number}`,
        pendingDraft: pendingDraft ? {
          id: pendingDraft.id,
          github_review_id: pendingDraft.github_review_id,
          github_node_id: pendingDraft.github_node_id,
          github_url: pendingDraft.github_url,
          comments_count: pendingDraft.comments_count || 0,
          created_at: pendingDraft.created_at
        } : null
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Error fetching PR data:', error);
    res.status(500).json({
      error: 'Internal server error while fetching pull request data'
    });
  }
});

/**
 * Refresh pull request data from GitHub
 */
router.post('/api/pr/:owner/:repo/:number/refresh', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');
    const config = req.app.get('config');

    logger.info(`Refreshing PR #${prNumber} for ${repository}`);

    // Check if PR exists in database
    const existingPR = await queryOne(db, `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!existingPR) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found in repository ${repository}`
      });
    }

    // Fetch fresh PR data from GitHub
    const githubClient = new GitHubClient(config.github_token);
    const prData = await githubClient.fetchPullRequest(owner, repo, prNumber);

    // Update worktree with latest changes
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.updateWorktree(owner, repo, prNumber, prData);

    // Generate fresh diff and get changed files
    const diffPrData = {
      base_sha: prData.base_sha,
      head_sha: prData.head_sha
    };
    const diff = await worktreeManager.generateUnifiedDiff(worktreePath, diffPrData);
    const changedFiles = await worktreeManager.getChangedFiles(worktreePath, diffPrData);

    // Prepare extended data
    const extendedData = {
      state: prData.state,
      diff: diff,
      changed_files: changedFiles,
      additions: prData.additions || 0,
      deletions: prData.deletions || 0,
      html_url: prData.html_url,
      base_sha: prData.base_sha,
      head_sha: prData.head_sha,
      node_id: prData.node_id  // GraphQL node ID for PR (required for GraphQL review submission)
    };

    // Update database with new data
    await run(db, `
      UPDATE pr_metadata
      SET
        title = ?,
        description = ?,
        base_branch = ?,
        head_branch = ?,
        updated_at = CURRENT_TIMESTAMP,
        pr_data = ?
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [
      prData.title,
      prData.body || '',
      prData.base_branch,
      prData.head_branch,
      JSON.stringify(extendedData),
      prNumber,
      repository
    ]);

    logger.info(`Successfully refreshed PR #${prNumber} for ${repository}`);

    // Get or create a review record for this PR
    // The review.id is used for comments to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    // Fetch and return updated PR data (reuse the same structure as GET endpoint)
    const prMetadata = await queryOne(db, `
      SELECT
        id,
        pr_number,
        repository,
        title,
        description,
        author,
        base_branch,
        head_branch,
        created_at,
        updated_at,
        pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    const parsedData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    const [repoOwner, repoName] = repository.split('/');

    // Use review.id instead of prMetadata.id to avoid ID collision with local mode
    const response = {
      success: true,
      data: {
        id: review.id,
        owner: repoOwner,
        repo: repoName,
        number: prMetadata.pr_number,
        title: prMetadata.title,
        body: prMetadata.description,
        author: prMetadata.author,
        state: parsedData.state || 'open',
        base_branch: prMetadata.base_branch,
        head_branch: prMetadata.head_branch,
        created_at: prMetadata.created_at,
        updated_at: prMetadata.updated_at,
        file_changes: parsedData.changed_files ? parsedData.changed_files.length : 0,
        additions: parsedData.additions || 0,
        deletions: parsedData.deletions || 0,
        diff_content: parsedData.diff || '',
        html_url: parsedData.html_url || `https://github.com/${repoOwner}/${repoName}/pull/${prMetadata.pr_number}`,
        head_sha: parsedData.head_sha,
        base_sha: parsedData.base_sha,
        node_id: parsedData.node_id
      }
    };

    res.json(response);

  } catch (error) {
    logger.error('Error refreshing PR:', error);
    res.status(500).json({
      error: 'Failed to refresh pull request: ' + error.message
    });
  }
});

/**
 * Check if PR data is stale (remote has newer commits)
 */
router.get('/api/pr/:owner/:repo/:number/check-stale', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');
    const config = req.app.get('config');

    // Get local PR data from database
    const prMetadata = await queryOne(db, `
      SELECT pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!prMetadata || !prMetadata.pr_data) {
      // No local data, can't determine staleness - return null (unknown)
      return res.json({
        isStale: null,
        error: 'No local PR data found'
      });
    }

    // Extract localHeadSha from the pr_data JSON
    let localPrData;
    try {
      localPrData = JSON.parse(prMetadata.pr_data);
    } catch (parseError) {
      return res.json({
        isStale: null,
        error: 'Failed to parse local PR data'
      });
    }

    const localHeadSha = localPrData.head_sha;
    if (!localHeadSha) {
      return res.json({
        isStale: null,
        error: 'No head SHA in local PR data'
      });
    }

    // Fetch current PR from GitHub
    const githubClient = new GitHubClient(config.github_token);
    const remotePrData = await githubClient.fetchPullRequest(owner, repo, prNumber);

    const remoteHeadSha = remotePrData.head_sha;
    const isStale = localHeadSha !== remoteHeadSha;

    res.json({
      isStale,
      localHeadSha,
      remoteHeadSha,
      prState: remotePrData.state,
      merged: remotePrData.merged
    });

  } catch (error) {
    // Fail-open: on any error, return isStale: null (unknown) so analysis can proceed
    logger.warn('Error checking PR staleness:', error.message);

    // Provide more helpful error messages based on error type
    let errorMessage = error.message;
    if (error.status === 404) {
      errorMessage = 'PR not found on GitHub';
    } else if (error.status === 401 || error.status === 403) {
      errorMessage = 'GitHub authentication issue';
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Could not connect to GitHub';
    }

    res.json({
      isStale: null,
      error: errorMessage
    });
  }
});

/**
 * Get pending GitHub draft review status for a PR
 * Fetches from GitHub and syncs with local database
 */
router.get('/api/pr/:owner/:repo/:number/github-drafts', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');
    const config = req.app.get('config');

    // Get the local review record if it exists (don't create on GET - REST compliance)
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);
    if (!review) {
      return res.json({ pendingDraft: null, allGithubReviews: [] });
    }

    // Initialize GitHub client and check for pending drafts on GitHub
    const githubToken = config.github_token || req.app.get('githubToken');
    if (!githubToken) {
      return res.status(500).json({
        error: 'GitHub token not configured. Please check your ~/.pair-review/config.json'
      });
    }

    const githubClient = new GitHubClient(githubToken);
    const githubReviewRepo = new GitHubReviewRepository(db);

    // Fetch pending review from GitHub
    let pendingDraft = null;
    try {
      const githubPendingReview = await githubClient.getPendingReviewForUser(owner, repo, prNumber);

      if (githubPendingReview) {
        pendingDraft = await syncPendingDraftFromGitHub(githubReviewRepo, review.id, githubPendingReview, githubClient);
      }
    } catch (githubError) {
      // Log the error but don't fail the request - return local data only
      logger.warn('Failed to fetch pending review from GitHub:', githubError.message);
    }

    // Get all github_reviews records for this review
    const allGithubReviews = await githubReviewRepo.findByReviewId(review.id);

    res.json({
      pendingDraft: pendingDraft ? {
        id: pendingDraft.id,
        github_review_id: pendingDraft.github_review_id,
        github_node_id: pendingDraft.github_node_id,
        github_url: pendingDraft.github_url,
        comments_count: pendingDraft.comments_count || 0,
        created_at: pendingDraft.created_at
      } : null,
      allGithubReviews
    });

  } catch (error) {
    logger.error('Error fetching GitHub draft status:', error);
    res.status(500).json({
      error: 'Internal server error while fetching GitHub draft status'
    });
  }
});

/**
 * Get list of pull requests
 */
router.get('/api/prs', async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 10, 50); // Max 50 items
    const offsetNum = parseInt(offset) || 0;

    const prs = await query(req.app.get('db'), `
      SELECT
        pr_number,
        repository,
        title,
        author,
        base_branch,
        head_branch,
        created_at,
        updated_at
      FROM pr_metadata
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `, [limitNum, offsetNum]);

    res.json({
      prs,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        count: prs.length
      }
    });

  } catch (error) {
    console.error('Error fetching PR list:', error);
    res.status(500).json({
      error: 'Internal server error while fetching pull requests'
    });
  }
});

/**
 * Get PR diff data
 */
router.get('/api/pr/:owner/:repo/:number/diff', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);

    // Get PR data including diff
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!prMetadata || !prMetadata.pr_data) {
      return res.status(404).json({
        error: `Diff data not found for pull request #${prNumber}`
      });
    }

    let prData;
    try {
      prData = JSON.parse(prMetadata.pr_data);
    } catch (error) {
      return res.status(500).json({
        error: 'Error parsing PR data'
      });
    }

    // Add generated flag to changed files based on .gitattributes
    let changedFiles = prData.changed_files || [];

    // Look up worktree path to read .gitattributes
    const db = req.app.get('db');
    const worktreeRepo = new WorktreeRepository(db);
    const worktreeRecord = await worktreeRepo.findByPR(prNumber, repository);

    if (worktreeRecord && worktreeRecord.path) {
      try {
        const gitattributes = await getGeneratedFilePatterns(worktreeRecord.path);
        changedFiles = changedFiles.map(file => ({
          ...file,
          generated: gitattributes.isGenerated(file.file)
        }));
      } catch (error) {
        console.warn('Could not load .gitattributes:', error.message);
        // Continue without generated flags
      }
    }

    res.json({
      diff: prData.diff || '',
      changed_files: changedFiles,
      stats: {
        additions: prData.additions || 0,
        deletions: prData.deletions || 0,
        changed_files: changedFiles.length
      }
    });

  } catch (error) {
    console.error('Error fetching PR diff:', error);
    res.status(500).json({
      error: 'Internal server error while fetching diff data'
    });
  }
});

/**
 * Get original file content from worktree for context expansion
 */
router.get('/api/file-content-original/:fileName(*)', async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName);

    // Get PR info from query parameters
    const { owner, repo, number } = req.query;

    if (!owner || !repo || !number) {
      return res.status(400).json({
        error: 'Missing required parameters: owner, repo, number'
      });
    }

    const db = req.app.get('db');

    // Handle local mode - owner='local' and number is a review ID
    if (owner === 'local') {
      const reviewId = parseInt(number);
      if (isNaN(reviewId) || reviewId <= 0) {
        return res.status(400).json({
          error: 'Invalid review ID for local mode'
        });
      }

      const reviewRepo = new ReviewRepository(db);
      const review = await reviewRepo.getLocalReviewById(reviewId);

      if (!review) {
        return res.status(404).json({
          error: 'Local review not found'
        });
      }

      const localPath = review.local_path;
      if (!localPath) {
        return res.status(404).json({
          error: 'Local review missing path'
        });
      }

      // Get local_head_sha for correct line number mapping during context expansion
      // Local mode diffs are generated against HEAD, so we need the HEAD version
      const localHeadSha = review.local_head_sha;

      // If we have local_head_sha, use git show to get the HEAD version of the file
      // This ensures line numbers match the diff's "before" state
      if (localHeadSha) {
        try {
          const git = simpleGit(localPath);
          // git show HEAD_SHA:path/to/file returns the file content at that commit
          const content = await git.show([`${localHeadSha}:${fileName}`]);
          const lines = content.split('\n');

          return res.json({
            fileName,
            lines,
            totalLines: lines.length
          });
        } catch (gitError) {
          // Fall through to filesystem read if git show fails for any reason:
          // - File might not exist at HEAD (new file in working directory)
          // - Git command might fail for other reasons
          logger.debug(`Could not read file ${fileName} from HEAD: ${gitError.message}, falling back to working directory`);
        }
      }

      // Fallback: Read from filesystem (working directory version)
      // This handles new files or cases where git show fails
      const filePath = path.join(localPath, fileName);

      try {
        // Security check - resolve symlinks and ensure file is within local path
        const realFilePath = await fs.realpath(filePath);
        const realLocalPath = await fs.realpath(localPath);
        if (!realFilePath.startsWith(realLocalPath + path.sep) && realFilePath !== realLocalPath) {
          return res.status(403).json({
            error: 'Access denied: path outside repository'
          });
        }

        const content = await fs.readFile(realFilePath, 'utf8');
        const lines = content.split('\n');

        return res.json({
          fileName,
          lines,
          totalLines: lines.length
        });

      } catch (fileError) {
        if (fileError.code === 'ENOENT') {
          return res.status(404).json({
            error: 'File not found in local repository'
          });
        } else if (fileError.code === 'EISDIR') {
          return res.status(400).json({
            error: 'Path is a directory, not a file'
          });
        } else {
          throw fileError;
        }
      }
    }

    // Standard PR mode handling
    const prNumber = parseInt(number);
    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. The PR may need to be reloaded.'
      });
    }

    // Get base_sha from the stored PR data
    // Context expansion needs content from the BASE version (old lines), not HEAD
    const repository = normalizeRepository(owner, repo);
    const prRecord = await queryOne(db, `
      SELECT pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    let baseSha = null;
    if (prRecord?.pr_data) {
      try {
        const prData = JSON.parse(prRecord.pr_data);
        baseSha = prData.base_sha;
      } catch (parseError) {
        console.warn('Could not parse pr_data for base_sha:', parseError.message);
      }
    }

    // If we have base_sha, use git show to get the BASE version of the file
    // This is critical for correct line number mapping during context expansion
    if (baseSha) {
      try {
        const git = simpleGit(worktreePath);
        // git show base_sha:path/to/file returns the file content at that commit
        const content = await git.show([`${baseSha}:${fileName}`]);
        const lines = content.split('\n');

        return res.json({
          fileName,
          lines,
          totalLines: lines.length
        });
      } catch (gitError) {
        // Fall through to filesystem read if git show fails for any reason:
        // - File might not exist at base_sha (new file)
        // - Worktree might not be a valid git repo (test environment)
        // - Git command might fail for other reasons
        logger.debug(`Could not read file ${fileName} from base commit: ${gitError.message}, falling back to HEAD`);
      }
    }

    // Fallback: Read from filesystem (HEAD version) if base_sha unavailable or file is new
    const filePath = path.join(worktreePath, fileName);

    try {
      // Security check - resolve symlinks and ensure file is within worktree
      const realFilePath = await fs.realpath(filePath);
      const realWorktreePath = await fs.realpath(worktreePath);
      if (!realFilePath.startsWith(realWorktreePath + path.sep) && realFilePath !== realWorktreePath) {
        return res.status(403).json({
          error: 'Access denied: path outside repository'
        });
      }

      // Read file content and split into lines
      const content = await fs.readFile(realFilePath, 'utf8');
      const lines = content.split('\n');

      res.json({
        fileName,
        lines,
        totalLines: lines.length
      });

    } catch (fileError) {
      if (fileError.code === 'ENOENT') {
        return res.status(404).json({
          error: 'File not found in worktree'
        });
      } else if (fileError.code === 'EISDIR') {
        return res.status(400).json({
          error: 'Path is a directory, not a file'
        });
      } else {
        throw fileError;
      }
    }

  } catch (error) {
    console.error('Error retrieving file content:', error);
    res.status(500).json({
      error: 'Internal server error while retrieving file content'
    });
  }
});

/**
 * Submit review to GitHub
 */
router.post('/api/pr/:owner/:repo/:number/submit-review', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { event, body } = req.body; // event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | 'DRAFT'
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'DRAFT'].includes(event)) {
      return res.status(400).json({
        error: 'Invalid review event. Must be APPROVE, REQUEST_CHANGES, COMMENT, or DRAFT'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    // Get GitHub token from app context (set during app initialization)
    const githubToken = req.app.get('githubToken');
    if (!githubToken) {
      return res.status(500).json({
        error: 'GitHub token not configured. Please check your ~/.pair-review/config.json'
      });
    }

    // Initialize GitHub client
    const githubClient = new GitHubClient(githubToken);

    // Get PR metadata and worktree path
    const prMetadata = await queryOne(db, `
      SELECT id, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found`
      });
    }

    const prData = JSON.parse(prMetadata.pr_data);

    // Get or create a review record for this PR
    // Comments are associated with review.id, not prMetadata.id
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    // Get all active user comments for this PR using review.id
    const comments = await query(db, `
      SELECT
        id,
        file,
        line_start,
        line_end,
        body,
        diff_position,
        side,
        commit_sha,
        is_file_level
      FROM comments
      WHERE review_id = ? AND source = 'user' AND status = 'active'
      ORDER BY file, line_start
    `, [review.id]);

    // Get worktree path and generate diff for position calculation
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    let diffContent = '';
    try {
      diffContent = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    } catch (diffError) {
      console.warn('Could not generate diff for position calculation:', diffError.message);
      // Continue without diff - GitHub client will handle missing positions
    }

    // Format comments for GraphQL API
    // GraphQL supports both line-level comments (within diff hunks) and file-level comments
    // (for expanded context lines outside diff hunks via subjectType: FILE).
    //
    // Comments on expanded context lines (diff_position IS NULL) are formatted as file-level
    // comments with a "(Ref Line X)" prefix in the body.
    const prNodeId = prData.node_id;
    if (!prNodeId) {
      return res.status(400).json({
        error: 'PR node_id not available. Please refresh the PR data and try again.'
      });
    }

    const graphqlComments = comments.map(comment => {
      const side = comment.side || 'RIGHT';
      const isRange = comment.line_end && comment.line_end !== comment.line_start;

      // Check if this is an explicit file-level comment (is_file_level=1)
      // These are comments about the entire file, not tied to specific lines
      if (comment.is_file_level === 1) {
        console.log(`Formatting file-level comment: ${comment.file}`);

        return {
          path: comment.file,
          body: comment.body,
          isFileLevel: true
        };
      }

      // Detect expanded context comments (no diff_position)
      // These are submitted as file-level comments since GitHub API rejects
      // line-level comments on lines outside diff hunks.
      const isExpandedContext = comment.diff_position === null || comment.diff_position === undefined;

      if (isExpandedContext) {
        // File-level comment with line reference prefix
        const lineRef = isRange
          ? `(Ref Lines ${comment.line_start}-${comment.line_end})`
          : `(Ref Line ${comment.line_start})`;

        console.log(`Formatting file-level comment (expanded context): ${comment.file} ${lineRef}`);

        return {
          path: comment.file,
          body: `${lineRef} ${comment.body}`,
          isFileLevel: true
        };
      }

      console.log(`Formatting line comment: ${comment.file}:${comment.line_start}${isRange ? `-${comment.line_end}` : ''} side=${side}`);

      const commentObj = {
        path: comment.file,
        line: isRange ? comment.line_end : comment.line_start,
        body: comment.body,
        side: side,
        isFileLevel: false
      };

      if (isRange) {
        commentObj.start_line = comment.line_start;
      }

      return commentObj;
    });

    // Submit review using GraphQL API (supports file-level comments)
    console.log(`${event === 'DRAFT' ? 'Creating draft review' : 'Submitting review'} for PR #${prNumber} with ${comments.length} comments`);

    let githubReview;

    // Always check for existing pending draft first
    // GitHub only allows one pending review per user per PR
    const existingDraft = await githubClient.getPendingReviewForUser(owner, repo, prNumber);

    if (event === 'DRAFT') {
      // Delegate to createDraftReviewGraphQL (handles both new and existing drafts)
      githubReview = await githubClient.createDraftReviewGraphQL(
        prNodeId, body || '', graphqlComments, existingDraft?.id
      );
      // When adding to an existing draft, use the existing URL and include prior comments in total count
      if (existingDraft) {
        githubReview.html_url = githubReview.html_url || existingDraft.url;
        githubReview.comments_count = existingDraft.comments.totalCount + githubReview.comments_count;
      }
    } else {
      // For non-drafts, create/use review, add comments, and submit
      githubReview = await githubClient.createReviewGraphQL(prNodeId, event, body || '', graphqlComments, existingDraft?.id);
    }

    // ID storage strategy:
    // - github_reviews.github_review_id -> numeric database ID (consistent with syncPendingDraftFromGitHub)
    // - github_reviews.github_node_id -> GraphQL node ID (e.g., "PRR_kwDOM..."), always present
    // - reviewData JSON -> uses 'github_node_id' key for the GraphQL node ID
    // - reviews.review_id -> legacy column, no longer written (github_reviews table has taken over)
    const githubNodeId = String(githubReview.id); // GraphQL methods return node IDs
    // Use databaseId from the mutation response, or fall back to existingDraft's databaseId
    const githubDatabaseId = githubReview.databaseId
      ? String(githubReview.databaseId)
      : existingDraft ? String(existingDraft.databaseId) : null;

    // Build review metadata for database storage
    const reviewData = {
      github_node_id: githubNodeId,
      github_url: githubReview.html_url,
      event: event,
      body: body || '',
      comments_count: githubReview.comments_count
    };

    // Add timestamps based on review type
    if (event === 'DRAFT') {
      reviewData.created_at = new Date().toISOString();
    } else {
      reviewData.submitted_at = new Date().toISOString();
    }

    // Begin database transaction for submission tracking
    // Moved after GitHub API calls to avoid holding SQLite write lock during network requests.
    // Accepted risk: if the GitHub review succeeds but the DB transaction fails, the review
    // exists on GitHub with no local record. For drafts, syncPendingDraftFromGitHub can recover
    // on next page load. For submitted reviews, there is currently no reconciliation path.
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Update review record (status, timestamps, review_data JSON)
      // Note: reviews.review_id is legacy and no longer written; github_reviews table tracks GitHub IDs
      await reviewRepo.updateAfterSubmission(review.id, {
        event: event,
        reviewData: reviewData
      });

      // Create a github_reviews record to track this submission
      const githubReviewRepo = new GitHubReviewRepository(db);
      await githubReviewRepo.create(review.id, {
        github_review_id: githubDatabaseId,
        github_node_id: githubNodeId,
        state: event === 'DRAFT' ? 'pending' : 'submitted',
        event: event === 'DRAFT' ? null : event,
        body: body || '',
        submitted_at: event === 'DRAFT' ? null : new Date().toISOString(),
        github_url: githubReview.html_url
      });

      console.log(`${event === 'DRAFT' ? 'Draft review created' : 'Review submitted'} successfully: ${githubReview.html_url}${event === 'DRAFT' ? ' (Review ID: ' + githubReview.id + ')' : ''}`);

      // Update comments table to mark submitted comments
      const commentStatus = event === 'DRAFT' ? 'draft' : 'submitted';
      const commentUpdateTime = new Date().toISOString();
      for (const comment of comments) {
        await run(db, `
          UPDATE comments
          SET status = ?, updated_at = ?
          WHERE id = ?
        `, [commentStatus, commentUpdateTime, comment.id]);
      }

      // Commit transaction
      await run(db, 'COMMIT');

      // Send success response after all database operations complete
      res.json({
        success: true,
        message: `${event === 'DRAFT' ? 'Draft review created' : 'Review submitted'} successfully ${event === 'DRAFT' ? 'on' : 'to'} GitHub`,
        github_url: githubReview.html_url,
        comments_submitted: githubReview.comments_count,
        event: event,
        status: event === 'DRAFT' ? githubReview.state : undefined // Include status for drafts
      });

    } catch (submitError) {
      // Rollback transaction on error
      await run(db, 'ROLLBACK');
      throw submitError;
    }

  } catch (error) {
    console.error('Error submitting review:', error);

    // Handle different types of errors with appropriate messages
    if (error.message.includes('GitHub authentication failed')) {
      return res.status(401).json({
        error: 'GitHub authentication failed. Please check your token in ~/.pair-review/config.json'
      });
    } else if (error.message.includes('Insufficient permissions')) {
      return res.status(403).json({
        error: 'Insufficient permissions to submit review. Your GitHub token may need additional scopes.'
      });
    } else if (error.message.includes('not found')) {
      return res.status(404).json({
        error: error.message
      });
    } else if (error.message.includes('rate limit')) {
      return res.status(429).json({
        error: error.message
      });
    } else {
      return res.status(500).json({
        error: `Failed to submit review: ${error.message}`
      });
    }
  }
});

/**
 * Get viewed files for a PR
 */
router.get('/api/pr/:owner/:repo/:number/files/viewed', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    // Get PR metadata from database
    const prMetadata = await queryOne(db, `
      SELECT pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found in repository ${repository}`
      });
    }

    // Parse pr_data and extract viewedFiles
    let viewedFiles = [];
    if (prMetadata.pr_data) {
      try {
        const prData = JSON.parse(prMetadata.pr_data);
        viewedFiles = prData.viewedFiles || [];
      } catch (parseError) {
        console.warn('Error parsing pr_data JSON:', parseError);
      }
    }

    res.json({ files: viewedFiles });

  } catch (error) {
    console.error('Error fetching viewed files:', error);
    res.status(500).json({
      error: 'Internal server error while fetching viewed files'
    });
  }
});

/**
 * Save viewed files for a PR
 */
router.post('/api/pr/:owner/:repo/:number/files/viewed', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { files } = req.body;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    if (!Array.isArray(files)) {
      return res.status(400).json({
        error: 'files must be an array of file paths'
      });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    // Get existing PR metadata
    const prMetadata = await queryOne(db, `
      SELECT pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found in repository ${repository}`
      });
    }

    // Parse existing pr_data and merge with new viewedFiles
    let prData = {};
    if (prMetadata.pr_data) {
      try {
        prData = JSON.parse(prMetadata.pr_data);
      } catch (parseError) {
        console.warn('Error parsing existing pr_data JSON:', parseError);
      }
    }

    // Update viewedFiles
    prData.viewedFiles = files;

    // Save back to database
    await run(db, `
      UPDATE pr_metadata
      SET pr_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [JSON.stringify(prData), prNumber, repository]);

    res.json({
      success: true,
      files: files
    });

  } catch (error) {
    console.error('Error saving viewed files:', error);
    res.status(500).json({
      error: 'Internal server error while saving viewed files'
    });
  }
});

/**
 * Health check for PR API
 */
router.get('/api/pr/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pr-api',
    timestamp: new Date().toISOString()
  });
});

/**
 * Parse a PR URL and extract owner, repo, and PR number
 * Supports GitHub and Graphite URLs (with or without protocol)
 */
router.post('/api/parse-pr-url', (req, res) => {
  const { PRArgumentParser } = require('../github/parser');
  const parser = new PRArgumentParser();

  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      error: 'URL is required',
      valid: false
    });
  }

  const result = parser.parsePRUrl(url);

  if (result) {
    return res.json({
      valid: true,
      owner: result.owner,
      repo: result.repo,
      prNumber: result.number
    });
  }

  return res.status(400).json({
    error: 'Invalid PR URL. Please enter a GitHub or Graphite PR URL.',
    valid: false
  });
});

// ==========================================================================
// PR Analysis Routes
// ==========================================================================

/**
 * Trigger AI analysis for a PR
 */
router.post('/api/pr/:owner/:repo/:number/analyses', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    const { provider: requestProvider, model: requestModel, tier: requestTier, customInstructions: rawInstructions, skipLevel3: requestSkipLevel3, enabledLevels: requestEnabledLevels } = req.body || {};

    const MAX_INSTRUCTIONS_LENGTH = 5000;
    let requestInstructions = rawInstructions?.trim() || null;
    if (requestInstructions && requestInstructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return res.status(400).json({
        error: `Custom instructions exceed maximum length of ${MAX_INSTRUCTIONS_LENGTH} characters`
      });
    }

    const VALID_TIERS = ['fast', 'balanced', 'thorough', 'free', 'standard', 'premium'];
    if (requestTier && !VALID_TIERS.includes(requestTier)) {
      return res.status(400).json({
        error: `Invalid tier: "${requestTier}". Valid tiers: ${VALID_TIERS.join(', ')}`
      });
    }

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = normalizeRepository(owner, repo);

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const prMetadataRepo = new PRMetadataRepository(db);
    const prMetadata = await prMetadataRepo.getByPR(prNumber, repository);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    const { provider, model, repoInstructions, combinedInstructions } = await withTransaction(db, async () => {
      const repoSettingsRepo = new RepoSettingsRepository(db);
      const fetchedRepoSettings = await repoSettingsRepo.getRepoSettings(repository);

      let selectedProvider;
      if (requestProvider) {
        selectedProvider = requestProvider;
      } else if (fetchedRepoSettings && fetchedRepoSettings.default_provider) {
        selectedProvider = fetchedRepoSettings.default_provider;
      } else {
        const config = req.app.get('config') || {};
        selectedProvider = config.default_provider || config.provider || 'claude';
      }

      let selectedModel;
      if (requestModel) {
        selectedModel = requestModel;
      } else if (fetchedRepoSettings && fetchedRepoSettings.default_model) {
        selectedModel = fetchedRepoSettings.default_model;
      } else {
        selectedModel = getModel(req);
      }

      const fetchedRepoInstructions = fetchedRepoSettings?.default_instructions || null;
      const mergedInstructions = mergeInstructions(fetchedRepoInstructions, requestInstructions);

      if (requestInstructions) {
        await reviewRepo.upsertCustomInstructions(prNumber, repository, requestInstructions);
      }

      return {
        provider: selectedProvider,
        model: selectedModel,
        repoInstructions: fetchedRepoInstructions,
        combinedInstructions: mergedInstructions
      };
    });

    const runId = uuidv4();
    const analysisId = runId;

    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    const analysisRunRepo = new AnalysisRunRepository(db);
    const levelsConfig = parseEnabledLevels(requestEnabledLevels, requestSkipLevel3);
    await analysisRunRepo.create({
      id: runId,
      reviewId: review.id,
      provider,
      model,
      repoInstructions,
      requestInstructions,
      headSha: prMetadata.head_sha || null,
      configType: 'single',
      levelsConfig
    });

    const initialStatus = {
      id: analysisId,
      runId,
      reviewId: review.id,
      prNumber,
      repository,
      reviewType: 'pr',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: 'Starting analysis...',
      levels: {
        1: levelsConfig[1] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        2: levelsConfig[2] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        3: levelsConfig[3] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        4: { status: 'pending', progress: 'Pending' }
      },
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store review to analysis ID mapping (unified map using integer reviewId)
    reviewToAnalysisId.set(review.id, analysisId);

    broadcastProgress(analysisId, initialStatus);

    const analyzer = new Analyzer(req.app.get('db'), model, provider);

    logger.section(`AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Worktree: ${worktreePath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Review ID: ${review.id}`, 'magenta');
    logger.log('API', `Provider: ${provider}`, 'cyan');
    logger.log('API', `Model: ${model}`, 'cyan');
    const tier = requestTier || 'balanced';
    logger.log('API', `Tier: ${tier}`, 'cyan');
    if (combinedInstructions) {
      logger.log('API', `Custom instructions: ${combinedInstructions.length} chars`, 'cyan');
    }

    const progressCallback = createProgressCallback(analysisId);

    analyzer.analyzeLevel1(review.id, worktreePath, prMetadata, progressCallback, { repoInstructions, requestInstructions }, null, { analysisId, runId, skipRunCreation: true, tier, skipLevel3: requestSkipLevel3, enabledLevels: levelsConfig })
      .then(async result => {
        logger.section('Analysis Results');
        logger.success(`Analysis complete for PR #${prNumber}`);
        logger.success(`Found ${result.suggestions.length} suggestions:`);

        try {
          await prMetadataRepo.updateLastAiRunId(prMetadata.id, result.runId);
          logger.info(`Updated pr_metadata with last_ai_run_id: ${result.runId}`);
        } catch (updateError) {
          logger.warn(`Failed to update pr_metadata with last_ai_run_id: ${updateError.message}`);
        }

        if (result.summary) {
          try {
            await reviewRepo.upsertSummary(prNumber, repository, result.summary);
            logger.info(`Saved analysis summary to review record`);
            logger.section('Analysis Summary');
            logger.info(result.summary);
          } catch (summaryError) {
            logger.warn(`Failed to save analysis summary: ${summaryError.message}`);
          }
        }
        result.suggestions.forEach(s => {
          const icon = s.type === 'bug' ? '\uD83D\uDC1B' :
                       s.type === 'praise' ? '\u2B50' :
                       s.type === 'improvement' ? '\uD83D\uDCA1' :
                       s.type === 'security' ? '\uD83D\uDD12' :
                       s.type === 'performance' ? '\u26A1' :
                       s.type === 'design' ? '\uD83D\uDCD0' :
                       s.type === 'suggestion' ? '\uD83D\uDCAC' :
                       s.type === 'code-style' || s.type === 'style' ? '\uD83E\uDDF9' : '\uD83D\uDCDD';
          logger.log('Result', `${icon} ${s.type}: ${s.title} (${s.file}:${s.line_start})`, 'green');
        });

        const completionInfo = determineCompletionInfo(result);

        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          logger.warn('Analysis already completed or removed:', analysisId);
          return;
        }

        if (currentStatus.status === 'cancelled') {
          logger.info(`Analysis ${analysisId} was cancelled, skipping completion update`);
          return;
        }

        for (let i = 1; i <= completionInfo.completedLevel; i++) {
          currentStatus.levels[i] = {
            status: 'completed',
            progress: `Level ${i} complete`
          };
        }

        currentStatus.levels[4] = {
          status: 'completed',
          progress: 'Results finalized'
        };

        const completedStatus = {
          ...currentStatus,
          status: 'completed',
          level: completionInfo.completedLevel,
          completedLevel: completionInfo.completedLevel,
          completedAt: new Date().toISOString(),
          result,
          progress: completionInfo.progressMessage,
          suggestionsCount: completionInfo.totalSuggestions,
          filesAnalyzed: currentStatus?.filesAnalyzed || 0,
          filesRemaining: 0,
          currentFile: currentStatus?.totalFiles || 0,
          totalFiles: currentStatus?.totalFiles || 0
        };
        activeAnalyses.set(analysisId, completedStatus);

        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          logger.warn('Analysis status not found during error handling:', analysisId);
          return;
        }

        if (error.isCancellation) {
          logger.info(`Analysis cancelled for PR #${prNumber}`);
          return;
        }

        logger.error(`Analysis failed for PR #${prNumber}: ${error.message}`);

        for (let i = 1; i <= 4; i++) {
          currentStatus.levels[i] = {
            status: 'failed',
            progress: 'Failed'
          };
        }

        const failedStatus = {
          ...currentStatus,
          status: 'failed',
          level: 1,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);

        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up review to analysis ID mapping (unified map)
        reviewToAnalysisId.delete(review.id);
      });

    res.json({
      analysisId,
      runId,
      status: 'started',
      message: 'AI analysis started in background'
    });

  } catch (error) {
    logger.error('Error starting AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start AI analysis'
    });
  }
});

/**
 * Trigger council analysis for a PR
 */
router.post('/api/pr/:owner/:repo/:number/analyses/council', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);
    const { councilId, councilConfig: inlineConfig, customInstructions: rawInstructions, configType: requestConfigType } = req.body || {};

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({ error: 'Invalid pull request number' });
    }

    if (!councilId && !inlineConfig) {
      return res.status(400).json({ error: 'Either councilId or councilConfig is required' });
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');

    let councilConfig;
    let configType;
    if (councilId) {
      const councilRepo = new CouncilRepository(db);
      const council = await councilRepo.getById(councilId);
      if (!council) {
        return res.status(404).json({ error: 'Council not found' });
      }
      councilConfig = council.config;
      configType = requestConfigType || council.type || 'advanced';
    } else {
      councilConfig = inlineConfig;
      configType = requestConfigType || 'advanced';
    }

    councilConfig = normalizeCouncilConfig(councilConfig, configType);

    const configError = validateCouncilConfig(councilConfig, configType);
    if (configError) {
      return res.status(400).json({ error: `Invalid council config: ${configError}` });
    }

    const prMetadataRepo = new PRMetadataRepository(db);
    const prMetadata = await prMetadataRepo.getByPR(prNumber, repository);
    if (!prMetadata) {
      return res.status(404).json({ error: `Pull request #${prNumber} not found. Please load the PR first.` });
    }

    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({ error: 'Worktree not found for this PR. Please reload the PR.' });
    }

    const reviewRepo = new ReviewRepository(db);
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
    const repoInstructions = repoSettings?.default_instructions || null;
    const requestInstructions = rawInstructions?.trim() || null;

    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    if (requestInstructions) {
      await reviewRepo.upsertCustomInstructions(prNumber, repository, requestInstructions);
    }

    const { analysisId, runId } = await analysesRouter.launchCouncilAnalysis(
      db,
      {
        reviewId: review.id,
        worktreePath,
        prMetadata,
        changedFiles: null,
        repository,
        headSha: prMetadata.head_sha,
        logLabel: `PR #${prNumber}`,
        initialStatusExtra: { prNumber, reviewType: 'pr' },
        extraBroadcastKeys: null,
        onSuccess: async (result) => {
          if (result.summary) {
            await reviewRepo.upsertSummary(prNumber, repository, result.summary);
          }
        }
      },
      councilConfig,
      councilId,
      { repoInstructions, requestInstructions },
      configType
    );

    res.json({
      analysisId,
      runId,
      status: 'started',
      message: 'Council analysis started in background',
      isCouncil: true
    });
  } catch (error) {
    logger.error('Error starting council analysis:', error);
    res.status(500).json({ error: 'Failed to start council analysis' });
  }
});

module.exports = router;
