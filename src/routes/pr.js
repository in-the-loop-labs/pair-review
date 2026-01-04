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
const { query, queryOne, run, WorktreeRepository } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { getGeneratedFilePatterns } = require('../git/gitattributes');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const router = express.Router();

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

    const repository = `${owner}/${repo}`;

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
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found in repository ${repository}`
      });
    }

    // Get review data if it exists
    const reviewData = await queryOne(req.app.get('db'), `
      SELECT status, created_at as review_created_at, updated_at as review_updated_at
      FROM reviews
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    // Parse extended PR data
    let extendedData = {};
    try {
      extendedData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Parse owner and repo from repository field
    const [repoOwner, repoName] = repository.split('/');

    // Prepare response
    const response = {
      success: true,
      data: {
        id: prMetadata.id,
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
        html_url: extendedData.html_url || `https://github.com/${repoOwner}/${repoName}/pull/${prMetadata.pr_number}`
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

    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');
    const config = req.app.get('config');

    logger.info(`Refreshing PR #${prNumber} for ${repository}`);

    // Check if PR exists in database
    const existingPR = await queryOne(db, `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
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
    const worktreePath = await worktreeManager.updateWorktree(owner, repo, prNumber, prData.base_branch, prData.head_sha);

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
      WHERE pr_number = ? AND repository = ?
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
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    const parsedData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    const [repoOwner, repoName] = repository.split('/');

    const response = {
      success: true,
      data: {
        id: prMetadata.id,
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

    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');
    const config = req.app.get('config');

    // Get local PR data from database
    const prMetadata = await queryOne(db, `
      SELECT pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata || !prMetadata.pr_data) {
      // No local data, can't determine staleness - fail-open
      return res.json({
        isStale: false,
        error: 'No local PR data found'
      });
    }

    // Extract localHeadSha from the pr_data JSON
    let localPrData;
    try {
      localPrData = JSON.parse(prMetadata.pr_data);
    } catch (parseError) {
      return res.json({
        isStale: false,
        error: 'Failed to parse local PR data'
      });
    }

    const localHeadSha = localPrData.head_sha;
    if (!localHeadSha) {
      return res.json({
        isStale: false,
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
      prState: remotePrData.state
    });

  } catch (error) {
    // Fail-open: on any error, return isStale: false so analysis can proceed
    logger.warn('Error checking PR staleness:', error.message);
    res.json({
      isStale: false,
      error: error.message
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

    const repository = `${owner}/${repo}`;

    // Get PR data including diff
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT pr_data
      FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
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
 * Get PR comments
 */
router.get('/api/pr/:owner/:repo/:number/comments', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Get review ID first
    const review = await queryOne(req.app.get('db'), `
      SELECT id FROM reviews
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!review) {
      return res.json({ comments: [] });
    }

    // Get comments for this review
    const comments = await query(req.app.get('db'), `
      SELECT
        id,
        file_path,
        line_number,
        comment_text,
        comment_type,
        status,
        created_at
      FROM comments
      WHERE review_id = ?
      ORDER BY file_path, line_number, created_at
    `, [review.id]);

    res.json({ comments });

  } catch (error) {
    console.error('Error fetching PR comments:', error);
    res.status(500).json({
      error: 'Internal server error while fetching comments'
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

    const prNumber = parseInt(number);
    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const db = req.app.get('db');
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. The PR may need to be reloaded.'
      });
    }

    // Construct file path in worktree (use base branch version)
    const filePath = path.join(worktreePath, fileName);

    // Security check - ensure file is within worktree
    if (!filePath.startsWith(worktreePath)) {
      return res.status(400).json({
        error: 'Invalid file path'
      });
    }

    try {
      // Read file content and split into lines
      const content = await fs.readFile(filePath, 'utf8');
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

    const repository = `${owner}/${repo}`;
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
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found`
      });
    }

    const prData = JSON.parse(prMetadata.pr_data);

    // Get all active user comments for this PR
    const comments = await query(db, `
      SELECT
        id,
        file,
        line_start,
        line_end,
        body,
        diff_position,
        side,
        commit_sha
      FROM comments
      WHERE pr_id = ? AND source = 'user' AND status = 'active'
      ORDER BY file, line_start
    `, [prMetadata.id]);

    // Check if there are too many comments (GitHub API limit is ~50)
    if (comments.length > 50) {
      return res.status(400).json({
        error: `Too many comments (${comments.length}). GitHub API supports up to 50 inline comments per review. Please reduce the number of comments.`
      });
    }

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

      console.log(`Formatting line comment: ${comment.file}:${comment.line_start} side=${side}`);

      return {
        path: comment.file,
        line: isRange ? comment.line_end : comment.line_start,
        body: comment.body,
        side: side,
        isFileLevel: false
      };
    });

    // Begin database transaction for submission tracking
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Submit review using GraphQL API (supports file-level comments)
      console.log(`${event === 'DRAFT' ? 'Creating draft review' : 'Submitting review'} for PR #${prNumber} with ${comments.length} comments`);

      let githubReview;
      if (event === 'DRAFT') {
        // For drafts, create pending review and add comments but don't submit
        githubReview = await githubClient.createDraftReviewGraphQL(prNodeId, body || '', graphqlComments);
      } else {
        // For non-drafts, create, add comments, and submit
        githubReview = await githubClient.createReviewGraphQL(prNodeId, event, body || '', graphqlComments);
      }

      // Update reviews table with appropriate status
      const reviewStatus = event === 'DRAFT' ? 'draft' : 'submitted';
      const now = new Date().toISOString();

      const reviewData = {
        github_review_id: githubReview.id,
        github_url: githubReview.html_url,
        event: event,
        body: body || '',
        comments_count: githubReview.comments_count
      };

      // Add timestamps based on review type
      if (event === 'DRAFT') {
        reviewData.created_at = new Date().toISOString();
      } else {
        reviewData.submitted_at = githubReview.submitted_at;
      }

      // Insert or replace review record
      if (event === 'DRAFT') {
        await run(db, `
          INSERT OR REPLACE INTO reviews (pr_number, repository, status, review_id, updated_at, review_data)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [prNumber, repository, reviewStatus, githubReview.id, now, JSON.stringify(reviewData)]);
      } else {
        await run(db, `
          INSERT OR REPLACE INTO reviews (pr_number, repository, status, review_id, updated_at, submitted_at, review_data)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [prNumber, repository, reviewStatus, githubReview.id, now, now, JSON.stringify(reviewData)]);
      }

      console.log(`${event === 'DRAFT' ? 'Draft review created' : 'Review submitted'} successfully: ${githubReview.html_url}${event === 'DRAFT' ? ' (Review ID: ' + githubReview.id + ')' : ''}`);

      res.json({
        success: true,
        message: `${event === 'DRAFT' ? 'Draft review created' : 'Review submitted'} successfully ${event === 'DRAFT' ? 'on' : 'to'} GitHub`,
        github_url: githubReview.html_url,
        github_review_id: githubReview.id,
        comments_submitted: githubReview.comments_count,
        event: event,
        status: event === 'DRAFT' ? githubReview.state : undefined // Include status for drafts
      });

      // Update comments table to mark submitted comments
      // Note: Since comments table doesn't have github-specific columns in current schema,
      // we'll update the status to indicate submission
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
 * Health check for PR API
 */
router.get('/api/pr/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pr-api',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
