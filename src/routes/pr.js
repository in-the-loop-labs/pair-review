const express = require('express');
const { query, queryOne, run, WorktreeRepository } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { getGeneratedFilePatterns } = require('../git/gitattributes');
const Analyzer = require('../ai/analyzer');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const router = express.Router();

// Store active analysis runs in memory for status tracking
const activeAnalyses = new Map();

// Store mapping of PR (owner/repo/number) to analysis ID for tracking
const prToAnalysisId = new Map();

// Store SSE clients for real-time progress updates
const progressClients = new Map();

/**
 * Generate a consistent PR key for mapping
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} prNumber - Pull request number
 * @returns {string} PR key in format "owner/repo/number"
 */
function getPRKey(owner, repo, prNumber) {
  return `${owner}/${repo}/${prNumber}`;
}

/**
 * Get the model to use for AI analysis
 * Priority: CLI flag (PAIR_REVIEW_MODEL env var) > config.model > 'sonnet' default
 * @param {Object} req - Express request object
 * @returns {string} Model name to use
 */
function getModel(req) {
  // CLI flag takes priority (passed via environment variable)
  if (process.env.PAIR_REVIEW_MODEL) {
    return process.env.PAIR_REVIEW_MODEL;
  }

  // Config file setting
  const config = req.app.get('config');
  if (config && config.model) {
    return config.model;
  }

  // Default fallback
  return 'sonnet';
}

/**
 * Determine completion level and suggestion counts from analysis result
 * @param {Object} result - Analysis result object
 * @returns {Object} Completion information with level, counts, and progress message
 */
function determineCompletionInfo(result) {
  // Determine completed levels
  const completedLevel = result.level2Result?.level3Result ? 3 : (result.level2Result ? 2 : 1);
  
  // Check for orchestrated suggestions first, then fall back to individual levels
  let totalSuggestions = 0;
  let progressMessage = '';
  
  if (result.level2Result?.orchestratedSuggestions?.length > 0) {
    // We have orchestrated suggestions - use those as the final count
    totalSuggestions = result.level2Result.orchestratedSuggestions.length;
    progressMessage = `Analysis complete: ${totalSuggestions} orchestrated suggestions stored`;
    logger.success(`Orchestration successful: ${totalSuggestions} curated suggestions from all levels`);
  } else {
    // Fall back to individual level counts
    const level1Count = result.suggestions.length;
    const level2Count = result.level2Result?.suggestions?.length || 0;
    const level3Count = result.level2Result?.level3Result?.suggestions?.length || 0;
    totalSuggestions = level1Count + level2Count + level3Count;
    
    const levelDetails = [];
    if (level1Count > 0) levelDetails.push(`Level 1: ${level1Count}`);
    if (level2Count > 0) levelDetails.push(`Level 2: ${level2Count}`);
    if (level3Count > 0) levelDetails.push(`Level 3: ${level3Count}`);
    
    progressMessage = `Analysis complete: ${totalSuggestions} suggestions found (${levelDetails.join(', ')})`;
  }
  
  return {
    completedLevel,
    totalSuggestions,
    progressMessage
  };
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
        created_at: prMetadata.created_at,
        updated_at: prMetadata.updated_at,
        file_changes: extendedData.changed_files ? extendedData.changed_files.length : 0,
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
      head_sha: prData.head_sha
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
        html_url: parsedData.html_url || `https://github.com/${repoOwner}/${repoName}/pull/${prMetadata.pr_number}`
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
 * Trigger AI analysis for a PR (Level 1)
 */
router.post('/api/analyze/:owner/:repo/:pr', async (req, res) => {
  try {
    const { owner, repo, pr } = req.params;
    const prNumber = parseInt(pr);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Check if PR exists in database
    const db = req.app.get('db');
    const prMetadata = await queryOne(db, `
      SELECT id, base_branch, title, description, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    // Parse pr_data to get base_sha and head_sha
    let prData = {};
    try {
      prData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Merge parsed data into prMetadata for use in analysis
    prMetadata.base_sha = prData.base_sha;
    prMetadata.head_sha = prData.head_sha;

    // Get worktree path
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status with separate tracking for each level
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: 'Starting analysis...',
      // Track each level separately for parallel execution
      levels: {
        1: { status: 'running', progress: 'Starting...' },
        2: { status: 'running', progress: 'Starting...' },
        3: { status: 'running', progress: 'Starting...' },
        4: { status: 'pending', progress: 'Pending' }
      },
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store PR to analysis ID mapping
    const prKey = getPRKey(owner, repo, prNumber);
    prToAnalysisId.set(prKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance with model from config/CLI
    const model = getModel(req);
    const analyzer = new Analyzer(req.app.get('db'), model);

    // Log analysis start with colorful output
    logger.section(`AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Worktree: ${worktreePath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Model: ${model}`, 'cyan');

    // Create progress callback function that tracks each level separately
    const progressCallback = (progressUpdate) => {
      const currentStatus = activeAnalyses.get(analysisId);
      if (!currentStatus) return;

      const level = progressUpdate.level;

      // Update the specific level's status
      if (level && level >= 1 && level <= 3) {
        currentStatus.levels[level] = {
          status: progressUpdate.status || 'running',
          progress: progressUpdate.progress || 'In progress...'
        };
      }

      // Handle orchestration as level 4
      if (level === 'orchestration') {
        currentStatus.levels[4] = {
          status: progressUpdate.status || 'running',
          progress: progressUpdate.progress || 'Finalizing results...'
        };
      }

      // Update overall progress message if provided
      if (progressUpdate.progress && !level) {
        currentStatus.progress = progressUpdate.progress;
      }

      activeAnalyses.set(analysisId, currentStatus);
      broadcastProgress(analysisId, currentStatus);
    };
    
    // Start analysis asynchronously with progress callback
    analyzer.analyzeLevel1(prMetadata.id, worktreePath, prMetadata, progressCallback)
      .then(result => {
        logger.section('Analysis Results');
        logger.success(`Analysis complete for PR #${prNumber}`);
        logger.success(`Found ${result.suggestions.length} suggestions:`);
        result.suggestions.forEach(s => {
          const icon = s.type === 'bug' ? '🐛' :
                       s.type === 'praise' ? '⭐' :
                       s.type === 'improvement' ? '💡' :
                       s.type === 'security' ? '🔒' :
                       s.type === 'performance' ? '⚡' :
                       s.type === 'design' ? '📐' :
                       s.type === 'suggestion' ? '💬' :
                       s.type === 'code-style' || s.type === 'style' ? '🧹' : '📝';
          logger.log('Result', `${icon} ${s.type}: ${s.title} (${s.file}:${s.line_start})`, 'green');
        });

        // Determine completion status using extracted helper function
        const completionInfo = determineCompletionInfo(result);

        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          console.warn('Analysis already completed or removed:', analysisId);
          return;
        }

        // Mark all completed levels as completed
        for (let i = 1; i <= completionInfo.completedLevel; i++) {
          currentStatus.levels[i] = {
            status: 'completed',
            progress: `Level ${i} complete`
          };
        }

        // Mark orchestration (level 4) as completed
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

        // Broadcast completion status
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        logger.error(`Analysis failed for PR #${prNumber}: ${error.message}`);
        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          console.warn('Analysis status not found during error handling:', analysisId);
          return;
        }

        // Mark all levels as failed
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

        // Broadcast failure status
        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up PR to analysis ID mapping (always runs regardless of success/failure)
        const prKey = getPRKey(owner, repo, prNumber);
        prToAnalysisId.delete(prKey);
      });

    // Return analysis ID immediately
    res.json({
      analysisId,
      status: 'started',
      message: 'AI analysis started in background'
    });
    
  } catch (error) {
    console.error('Error starting AI analysis:', error);
    res.status(500).json({ 
      error: 'Failed to start AI analysis' 
    });
  }
});

/**
 * Trigger Level 2 AI analysis for a PR
 */
router.post('/api/analyze/:owner/:repo/:pr/level2', async (req, res) => {
  try {
    const { owner, repo, pr } = req.params;
    const prNumber = parseInt(pr);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Check if PR exists in database
    const db = req.app.get('db');
    const prMetadata = await queryOne(db, `
      SELECT id, base_branch, title, description, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    // Parse pr_data to get base_sha and head_sha
    let prData = {};
    try {
      prData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Merge parsed data into prMetadata for use in analysis
    prMetadata.base_sha = prData.base_sha;
    prMetadata.head_sha = prData.head_sha;

    // Get worktree path
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'started',
      level: 2,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 2 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store PR to analysis ID mapping
    const prKey = getPRKey(owner, repo, prNumber);
    prToAnalysisId.set(prKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance with model from config/CLI
    const model = getModel(req);
    const analyzer = new Analyzer(req.app.get('db'), model);

    logger.section(`Level 2 AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Model: ${model}`, 'cyan');

    // Create progress callback function
    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        // Don't override the level if it's already set in progressUpdate
        level: progressUpdate.level || 2
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };
    
    // Start Level 2 analysis asynchronously
    analyzer.analyzeLevel2(prMetadata.id, worktreePath, prMetadata, progressCallback)
      .then(result => {
        const completedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'completed',
          level: 2,
          completedLevel: 2,
          completedAt: new Date().toISOString(),
          result,
          progress: `Level 2 analysis complete: ${result.suggestions.length} suggestions found`
        };
        activeAnalyses.set(analysisId, completedStatus);
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        const failedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'failed',
          level: 2,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Level 2 analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);
        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up PR to analysis ID mapping (always runs regardless of success/failure)
        const prKey = getPRKey(owner, repo, prNumber);
        prToAnalysisId.delete(prKey);
      });

    res.json({
      analysisId,
      status: 'started',
      level: 2,
      message: 'Level 2 AI analysis started in background'
    });
    
  } catch (error) {
    console.error('Error starting Level 2 AI analysis:', error);
    res.status(500).json({ 
      error: 'Failed to start Level 2 AI analysis' 
    });
  }
});

/**
 * Trigger Level 3 AI analysis for a PR
 */
router.post('/api/analyze/:owner/:repo/:pr/level3', async (req, res) => {
  try {
    const { owner, repo, pr } = req.params;
    const prNumber = parseInt(pr);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Check if PR exists in database
    const db = req.app.get('db');
    const prMetadata = await queryOne(db, `
      SELECT id, base_branch, title, description, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    // Parse pr_data to get base_sha and head_sha
    let prData = {};
    try {
      prData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Merge parsed data into prMetadata for use in analysis
    prMetadata.base_sha = prData.base_sha;
    prMetadata.head_sha = prData.head_sha;

    // Get worktree path
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    // Create analysis ID
    const analysisId = uuidv4();
    
    // Store analysis status
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'started',
      level: 3,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 3 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store PR to analysis ID mapping
    const prKey = getPRKey(owner, repo, prNumber);
    prToAnalysisId.set(prKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance with model from config/CLI
    const model = getModel(req);
    const analyzer = new Analyzer(req.app.get('db'), model);

    logger.section(`Level 3 AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Model: ${model}`, 'cyan');

    // Create progress callback function
    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        // Don't override the level if it's already set in progressUpdate
        level: progressUpdate.level || 3
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };
    
    // Start Level 3 analysis asynchronously
    analyzer.analyzeLevel3(prMetadata.id, worktreePath, prMetadata, progressCallback)
      .then(result => {
        const completedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'completed',
          level: 3,
          completedLevel: 3,
          completedAt: new Date().toISOString(),
          result,
          progress: `Level 3 analysis complete: ${result.suggestions.length} suggestions found`
        };
        activeAnalyses.set(analysisId, completedStatus);
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        const failedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'failed',
          level: 3,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Level 3 analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);
        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up PR to analysis ID mapping (always runs regardless of success/failure)
        const prKey = getPRKey(owner, repo, prNumber);
        prToAnalysisId.delete(prKey);
      });

    res.json({
      analysisId,
      status: 'started',
      level: 3,
      message: 'Level 3 AI analysis started in background'
    });
    
  } catch (error) {
    console.error('Error starting Level 3 AI analysis:', error);
    res.status(500).json({ 
      error: 'Failed to start Level 3 AI analysis' 
    });
  }
});

/**
 * Get AI analysis status
 */
router.get('/api/analyze/status/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const analysis = activeAnalyses.get(id);

    if (!analysis) {
      return res.status(404).json({
        error: 'Analysis not found'
      });
    }

    res.json(analysis);

  } catch (error) {
    console.error('Error fetching analysis status:', error);
    res.status(500).json({
      error: 'Failed to fetch analysis status'
    });
  }
});

/**
 * Check if analysis is running for a specific PR
 */
router.get('/api/pr/:owner/:repo/:number/analysis-status', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prKey = getPRKey(owner, repo, number);

    const analysisId = prToAnalysisId.get(prKey);

    if (!analysisId) {
      return res.json({
        running: false,
        analysisId: null,
        status: null
      });
    }

    const analysis = activeAnalyses.get(analysisId);

    if (!analysis) {
      // Clean up stale mapping
      prToAnalysisId.delete(prKey);
      return res.json({
        running: false,
        analysisId: null,
        status: null
      });
    }

    res.json({
      running: true,
      analysisId,
      status: analysis
    });

  } catch (error) {
    console.error('Error checking PR analysis status:', error);
    res.status(500).json({
      error: 'Failed to check analysis status'
    });
  }
});

/**
 * Check if a PR has existing AI suggestions
 */
router.get('/api/pr/:owner/:repo/:number/has-ai-suggestions', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Get PR metadata to find pr_id
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found`
      });
    }

    // Check if any AI suggestions exist for this PR
    const result = await queryOne(req.app.get('db'), `
      SELECT EXISTS(
        SELECT 1 FROM comments
        WHERE pr_id = ? AND source = 'ai'
      ) as has_suggestions
    `, [prMetadata.id]);

    const hasSuggestions = result?.has_suggestions === 1;

    res.json({
      hasSuggestions: hasSuggestions
    });
  } catch (error) {
    console.error('Error checking for AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to check for AI suggestions'
    });
  }
});

/**
 * Get AI suggestions for a PR (compatibility endpoint with owner/repo/number)
 */
router.get('/api/pr/:owner/:repo/:number/ai-suggestions', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Get PR ID
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found`
      });
    }

    // Parse levels query parameter (e.g., ?levels=final,1,2)
    // Default to 'final' (orchestrated suggestions only) if not specified
    const levelsParam = req.query.levels || 'final';
    const requestedLevels = levelsParam.split(',').map(l => l.trim());

    // Build level filter clause
    const levelConditions = [];
    requestedLevels.forEach(level => {
      if (level === 'final') {
        levelConditions.push('ai_level IS NULL');
      } else if (['1', '2', '3'].includes(level)) {
        levelConditions.push(`ai_level = ${parseInt(level)}`);
      }
    });

    // If no valid levels specified, default to final
    const levelFilter = levelConditions.length > 0
      ? `(${levelConditions.join(' OR ')})`
      : 'ai_level IS NULL';

    // Get AI suggestions from the comments table
    // Support filtering by analysis level via query parameter
    const suggestions = await query(req.app.get('db'), `
      SELECT
        id,
        source,
        author,
        ai_run_id,
        ai_level,
        ai_confidence,
        file,
        line_start,
        line_end,
        type,
        title,
        body,
        status,
        created_at,
        updated_at
      FROM comments
      WHERE pr_id = ? AND source = 'ai' AND ${levelFilter} AND status IN ('active', 'dismissed', 'adopted')
      ORDER BY
        CASE
          WHEN ai_level IS NULL THEN 0
          WHEN ai_level = 1 THEN 1
          WHEN ai_level = 2 THEN 2
          WHEN ai_level = 3 THEN 3
          ELSE 4
        END,
        file,
        line_start
    `, [prMetadata.id]);

    res.json({ suggestions });

  } catch (error) {
    console.error('Error fetching AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to fetch AI suggestions'
    });
  }
});

/**
 * Edit AI suggestion and adopt as user comment
 */
router.post('/api/ai-suggestion/:id/edit', async (req, res) => {
  try {
    const { id } = req.params;
    const { editedText, action } = req.body;
    
    if (action !== 'adopt_edited') {
      return res.status(400).json({ 
        error: 'Invalid action. Must be "adopt_edited"' 
      });
    }

    if (!editedText || !editedText.trim()) {
      return res.status(400).json({ 
        error: 'Edited text cannot be empty' 
      });
    }

    const db = req.app.get('db');
    
    // Get the suggestion and validate it
    const suggestion = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'ai'
    `, [id]);

    if (!suggestion) {
      return res.status(404).json({ 
        error: 'AI suggestion not found' 
      });
    }

    // Validate suggestion status is active
    if (suggestion.status !== 'active') {
      return res.status(400).json({ 
        error: 'This suggestion has already been processed' 
      });
    }

    // Validate PR exists
    const pr = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE id = ?
    `, [suggestion.pr_id]);

    if (!pr) {
      return res.status(404).json({ 
        error: 'Associated pull request not found' 
      });
    }

    // Create a user comment with the edited text
    const result = await run(db, `
      INSERT INTO comments (
        pr_id, source, author, file, line_start, line_end, 
        type, title, body, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      suggestion.pr_id,
      'user',
      'Current User', // TODO: Get actual user from session/config
      suggestion.file,
      suggestion.line_start,
      suggestion.line_end,
      'comment',
      suggestion.title,
      editedText.trim(),
      'active'
    ]);
    
    const userCommentId = result.lastID;

    // Update suggestion status to adopted and link to user comment
    await run(db, `
      UPDATE comments 
      SET status = 'adopted', adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [userCommentId, id]);

    res.json({ 
      success: true,
      userCommentId,
      message: 'Suggestion edited and adopted as user comment'
    });
    
  } catch (error) {
    console.error('Error editing suggestion:', error);
    res.status(500).json({ 
      error: 'Failed to edit suggestion' 
    });
  }
});

/**
 * Update AI suggestion status
 * Sets status to 'adopted', 'dismissed', or 'active' (restored)
 * Note: This only updates the status flag. For 'adopted' status, the actual
 * user comment creation is handled separately via /api/user-comment endpoint.
 */
router.post('/api/ai-suggestion/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['adopted', 'dismissed', 'active'].includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Must be "adopted", "dismissed", or "active"' 
      });
    }

    const db = req.app.get('db');
    
    // Get the suggestion
    const suggestion = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'ai'
    `, [id]);

    if (!suggestion) {
      return res.status(404).json({ 
        error: 'AI suggestion not found' 
      });
    }

    // Update suggestion status
    // When restoring to active, we need to clear adopted_as_id
    // Note: User comment creation for adopted suggestions is handled separately
    // by the frontend via /api/user-comment endpoint to avoid duplicate comments
    if (status === 'active') {
      await run(db, `
        UPDATE comments
        SET status = ?, adopted_as_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, id]);
    } else {
      await run(db, `
        UPDATE comments
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, id]);
    }

    res.json({
      success: true,
      status
    });
    
  } catch (error) {
    console.error('Error updating suggestion status:', error);
    res.status(500).json({ 
      error: 'Failed to update suggestion status' 
    });
  }
});

/**
 * Server-Sent Events endpoint for AI analysis progress
 */
router.get('/api/pr/:id/ai-suggestions/status', (req, res) => {
  const analysisId = req.params.id;
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial connection message
  res.write('data: {"type":"connected","message":"Connected to progress stream"}\n\n');

  // Store client for this analysis
  if (!progressClients.has(analysisId)) {
    progressClients.set(analysisId, new Set());
  }
  progressClients.get(analysisId).add(res);

  // Send current status if analysis exists
  const currentStatus = activeAnalyses.get(analysisId);
  if (currentStatus) {
    res.write(`data: ${JSON.stringify({
      type: 'progress',
      ...currentStatus
    })}\n\n`);
  }

  // Handle client disconnect
  req.on('close', () => {
    const clients = progressClients.get(analysisId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        progressClients.delete(analysisId);
      }
    }
  });

  req.on('error', () => {
    const clients = progressClients.get(analysisId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        progressClients.delete(analysisId);
      }
    }
  });
});

/**
 * Broadcast progress update to all connected SSE clients
 * @param {string} analysisId - Analysis ID
 * @param {Object} progressData - Progress data to broadcast
 */
function broadcastProgress(analysisId, progressData) {
  const clients = progressClients.get(analysisId);
  if (clients && clients.size > 0) {
    const message = `data: ${JSON.stringify({
      type: 'progress',
      ...progressData
    })}\n\n`;
    
    // Send to all connected clients
    clients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        // Remove dead clients
        clients.delete(client);
      }
    });
    
    // Clean up if no clients left
    if (clients.size === 0) {
      progressClients.delete(analysisId);
    }
  }
}

/**
 * Create user comment
 */
router.post('/api/user-comment', async (req, res) => {
  try {
    const { pr_id, file, line_start, line_end, diff_position, side, commit_sha, body, parent_id, type, title } = req.body;

    if (!pr_id || !file || !line_start || !body) {
      return res.status(400).json({
        error: 'Missing required fields: pr_id, file, line_start, body'
      });
    }

    const db = req.app.get('db');

    // Verify PR exists
    const pr = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE id = ?
    `, [pr_id]);

    if (!pr) {
      return res.status(404).json({
        error: 'Pull request not found'
      });
    }

    // Create user comment with optional parent_id and metadata
    // Validate side if provided (must be LEFT or RIGHT)
    const validSide = side === 'LEFT' ? 'LEFT' : 'RIGHT';

    const result = await run(db, `
      INSERT INTO comments (
        pr_id, source, author, file, line_start, line_end, diff_position, side, commit_sha,
        type, title, body, status, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      pr_id,
      'user',
      'Current User', // TODO: Get actual user from session/config
      file,
      line_start,
      line_end || line_start,
      diff_position || null,  // Store diff position for legacy fallback
      validSide,              // LEFT for deleted lines, RIGHT for added/context
      commit_sha || null,     // Commit SHA for new GitHub API (line/side/commit_id)
      type || 'comment',  // Use provided type or default to 'comment'
      title || null,       // Optional title from AI suggestion
      body.trim(),
      'active',
      parent_id || null    // Link to parent AI suggestion if adopted
    ]);
    
    res.json({ 
      success: true,
      commentId: result.lastID,
      message: 'Comment saved successfully'
    });
    
  } catch (error) {
    console.error('Error creating user comment:', error);
    res.status(500).json({ 
      error: 'Failed to create comment' 
    });
  }
});

/**
 * Get user comments for a PR (by owner/repo/number format for consistency)
 */
router.get('/api/pr/:owner/:repo/:number/user-comments', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);
    
    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({ 
        error: 'Invalid pull request number' 
      });
    }

    const repository = `${owner}/${repo}`;
    
    // Get PR ID first
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.json({
        success: true,
        comments: []
      });
    }

    const comments = await query(req.app.get('db'), `
      SELECT 
        id,
        source,
        author,
        file,
        line_start,
        line_end,
        type,
        title,
        body,
        status,
        parent_id,
        created_at,
        updated_at
      FROM comments
      WHERE pr_id = ? AND source = 'user' AND status = 'active'
      ORDER BY file, line_start, created_at
    `, [prMetadata.id]);

    res.json({
      success: true,
      comments: comments || []
    });

  } catch (error) {
    console.error('Error fetching user comments:', error);
    res.status(500).json({ 
      error: 'Failed to fetch user comments' 
    });
  }
});

/**
 * Get user comments for a PR (legacy endpoint by ID)
 */
router.get('/api/pr/:id/user-comments', async (req, res) => {
  try {
    const prId = parseInt(req.params.id);
    
    if (isNaN(prId) || prId <= 0) {
      return res.status(400).json({ 
        error: 'Invalid PR ID' 
      });
    }

    const comments = await query(req.app.get('db'), `
      SELECT 
        id,
        source,
        author,
        file,
        line_start,
        line_end,
        type,
        title,
        body,
        status,
        parent_id,
        created_at,
        updated_at
      FROM comments
      WHERE pr_id = ? AND source = 'user' AND status = 'active'
      ORDER BY file, line_start, created_at
    `, [prId]);

    res.json({
      success: true,
      comments: comments || []
    });

  } catch (error) {
    console.error('Error fetching user comments:', error);
    res.status(500).json({ 
      error: 'Failed to fetch user comments' 
    });
  }
});

/**
 * Get single user comment
 */
router.get('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.get('db');
    
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      return res.status(404).json({ 
        error: 'User comment not found' 
      });
    }

    res.json(comment);
    
  } catch (error) {
    console.error('Error fetching user comment:', error);
    res.status(500).json({ 
      error: 'Failed to fetch comment' 
    });
  }
});

/**
 * Update user comment
 */
router.put('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { body } = req.body;
    
    if (!body || !body.trim()) {
      return res.status(400).json({ 
        error: 'Comment body cannot be empty' 
      });
    }

    const db = req.app.get('db');
    
    // Get the comment and verify it exists and is a user comment
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      return res.status(404).json({ 
        error: 'User comment not found' 
      });
    }

    // Update comment
    await run(db, `
      UPDATE comments 
      SET body = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [body.trim(), id]);

    res.json({ 
      success: true,
      message: 'Comment updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating user comment:', error);
    res.status(500).json({ 
      error: 'Failed to update comment' 
    });
  }
});

/**
 * Delete user comment
 */
router.delete('/api/user-comment/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const db = req.app.get('db');
    
    // Get the comment and verify it exists and is a user comment
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND source = 'user'
    `, [id]);

    if (!comment) {
      return res.status(404).json({ 
        error: 'User comment not found' 
      });
    }

    // Soft delete by setting status to inactive
    await run(db, `
      UPDATE comments 
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    res.json({ 
      success: true,
      message: 'Comment deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting user comment:', error);
    res.status(500).json({ 
      error: 'Failed to delete comment' 
    });
  }
});

/**
 * Bulk delete all user comments for a PR
 */
router.delete('/api/pr/:owner/:repo/:number/user-comments', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const db = req.app.get('db');
    const repository = `${owner}/${repo}`;

    // Get the PR ID to verify it exists
    const prMetadata = await queryOne(db, `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: 'Pull request not found'
      });
    }

    // Begin transaction to ensure atomicity
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Soft delete all active user comments for this PR
      const result = await run(db, `
        UPDATE comments
        SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE pr_id = ? AND source = 'user' AND status = 'active'
      `, [prMetadata.id]);

      // Commit transaction
      await run(db, 'COMMIT');

      // Use actual number of affected rows from the UPDATE
      const deletedCount = result.changes;

      res.json({
        success: true,
        deletedCount: deletedCount,
        message: `Deleted ${deletedCount} user comment${deletedCount !== 1 ? 's' : ''}`
      });

    } catch (transactionError) {
      // Rollback transaction on error
      await run(db, 'ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('Error deleting user comments:', error);
    res.status(500).json({
      error: 'Failed to delete comments'
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

    // Format comments for GitHub API using new line/side/commit_id approach
    // The new API uses absolute line numbers anchored to a specific commit
    // instead of the legacy position-based approach
    const headSha = prData.head?.sha || null;
    const githubComments = comments.map(comment => ({
      path: comment.file,                // file path
      line: comment.line_start,          // absolute line number in the file
      body: comment.body,                // comment text
      side: comment.side || 'RIGHT',     // LEFT for deleted lines, RIGHT for added/context
      commit_id: comment.commit_sha || headSha,  // commit SHA for anchoring the comment
      diff_position: comment.diff_position  // legacy fallback (deprecated)
    }));

    // Begin database transaction for submission tracking
    await run(db, 'BEGIN TRANSACTION');
    
    try {
      // Submit review using single method that handles both drafts and final reviews
      console.log(`${event === 'DRAFT' ? 'Creating draft review' : 'Submitting review'} for PR #${prNumber} with ${comments.length} comments`);
      const githubReview = await githubClient.createReview(
        owner, 
        repo, 
        prNumber, 
        event, 
        body || '', 
        githubComments, 
        diffContent
      );
      
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

/**
 * Create worktree from PR URL (for web UI start review)
 * Creates worktree, fetches PR data from GitHub, stores in database
 */
router.post('/api/worktrees/create', async (req, res) => {
  try {
    const { owner, repo, prNumber } = req.body;

    // Validate required parameters
    if (!owner || !repo || !prNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: owner, repo, prNumber'
      });
    }

    const parsedPrNumber = parseInt(prNumber, 10);
    if (isNaN(parsedPrNumber) || parsedPrNumber <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pull request number'
      });
    }

    const db = req.app.get('db');
    const config = req.app.get('config');

    // Validate GitHub token
    if (!config || !config.github_token) {
      return res.status(500).json({
        success: false,
        error: 'GitHub token not configured. Please set github_token in ~/.pair-review/config.json'
      });
    }

    const repository = `${owner}/${repo}`;
    logger.section(`Web UI Start Review - PR #${parsedPrNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');

    // Create GitHub client and validate token
    const githubClient = new GitHubClient(config.github_token);
    const tokenValid = await githubClient.validateToken();
    if (!tokenValid) {
      return res.status(401).json({
        success: false,
        error: 'GitHub authentication failed. Please check your token in ~/.pair-review/config.json'
      });
    }

    // Check if repository is accessible
    const repoExists = await githubClient.repositoryExists(owner, repo);
    if (!repoExists) {
      return res.status(404).json({
        success: false,
        error: `Repository ${repository} not found or not accessible`
      });
    }

    // Fetch PR data from GitHub
    logger.info('Fetching pull request data from GitHub...');
    let prData;
    try {
      prData = await githubClient.fetchPullRequest(owner, repo, parsedPrNumber);
    } catch (error) {
      if (error.message && error.message.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: `Pull request #${parsedPrNumber} not found in ${repository}`
        });
      }
      throw error;
    }

    // Get current working directory for worktree creation
    // Since we're running from the web UI, we need to find a valid git repository
    // The worktree manager will handle this by using its configured base directory
    const worktreeManager = new GitWorktreeManager(db);

    // We need a source repository to create worktrees from
    // First check if we have an existing worktree for this repo
    const worktreeRepo = new WorktreeRepository(db);
    const existingWorktree = await worktreeRepo.findByPR(parsedPrNumber, repository);

    let repositoryPath;
    if (existingWorktree && await worktreeManager.pathExists(existingWorktree.path)) {
      // Use the existing worktree path to find the parent git repository
      const simpleGit = require('simple-git');
      try {
        const git = simpleGit(existingWorktree.path);
        repositoryPath = await git.revparse(['--show-toplevel']);
        repositoryPath = repositoryPath.trim();
      } catch {
        // If we can't get the git root, we'll need to clone
        repositoryPath = null;
      }
    }

    // If we don't have a repository path, we need to clone the repo first
    if (!repositoryPath) {
      // Check if there's a cached clone for this repository
      const { getConfigDir } = require('../config');
      const cachedRepoPath = path.join(getConfigDir(), 'repos', owner, repo);

      if (await worktreeManager.pathExists(cachedRepoPath)) {
        repositoryPath = cachedRepoPath;
        logger.info(`Using cached repository at ${repositoryPath}`);
      } else {
        // Clone the repository
        logger.info(`Cloning repository ${repository}...`);
        await fs.mkdir(path.dirname(cachedRepoPath), { recursive: true });

        const simpleGit = require('simple-git');
        const git = simpleGit();

        // Clone with minimal depth for efficiency
        const cloneUrl = `https://github.com/${owner}/${repo}.git`;
        try {
          await git.clone(cloneUrl, cachedRepoPath, ['--filter=blob:none', '--no-checkout']);
          repositoryPath = cachedRepoPath;
          logger.info(`Cloned repository to ${repositoryPath}`);
        } catch (cloneError) {
          return res.status(500).json({
            success: false,
            error: `Failed to clone repository: ${cloneError.message}`
          });
        }
      }
    }

    // Setup git worktree
    logger.info('Setting up git worktree...');
    const prInfo = { owner, repo, number: parsedPrNumber };
    const worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, repositoryPath);

    // Generate unified diff
    logger.info('Generating unified diff...');
    const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

    // Store PR data in database (similar to storePRData in main.js)
    logger.info('Storing pull request data...');
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Store or update worktree record
      await worktreeRepo.getOrCreate({
        prNumber: parsedPrNumber,
        repository,
        branch: prData.head_branch,
        path: worktreePath
      });

      // Prepare extended PR data
      const extendedPRData = {
        ...prData,
        diff: diff,
        changed_files: changedFiles,
        worktree_path: worktreePath,
        fetched_at: new Date().toISOString()
      };

      // Check if PR metadata exists
      const existingPR = await queryOne(db, `
        SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ?
      `, [parsedPrNumber, repository]);

      if (existingPR) {
        // Update existing PR metadata
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
          parsedPrNumber,
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
      const existingReview = await queryOne(db, `
        SELECT id FROM reviews WHERE pr_number = ? AND repository = ?
      `, [parsedPrNumber, repository]);

      if (existingReview) {
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
      } else {
        await run(db, `
          INSERT INTO reviews
          (pr_number, repository, status, review_data)
          VALUES (?, ?, 'draft', ?)
        `, [
          parsedPrNumber,
          repository,
          JSON.stringify({
            worktree_path: worktreePath,
            created_at: new Date().toISOString()
          })
        ]);
      }

      await run(db, 'COMMIT');
      logger.success(`Stored PR data for ${repository} #${parsedPrNumber}`);

    } catch (dbError) {
      await run(db, 'ROLLBACK');
      throw new Error(`Failed to store PR data: ${dbError.message}`);
    }

    // Return success with review URL
    const reviewUrl = `/pr/${owner}/${repo}/${parsedPrNumber}`;

    logger.success(`Review ready at ${reviewUrl}`);

    res.json({
      success: true,
      reviewUrl,
      prNumber: parsedPrNumber,
      repository,
      title: prData.title
    });

  } catch (error) {
    logger.error('Error creating worktree from web UI:', error);

    // Provide user-friendly error messages
    if (error.message && error.message.includes('authentication failed')) {
      return res.status(401).json({
        success: false,
        error: 'GitHub authentication failed. Please check your token.'
      });
    } else if (error.message && error.message.includes('rate limit')) {
      return res.status(429).json({
        success: false,
        error: 'GitHub API rate limit exceeded. Please try again later.'
      });
    } else if (error.message && error.message.includes('Network error')) {
      return res.status(503).json({
        success: false,
        error: 'Network error. Please check your internet connection.'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create worktree'
    });
  }
});

/**
 * Get recently accessed worktrees
 * Returns list of recently reviewed PRs with metadata
 * Filters out stale worktrees where the directory no longer exists
 */
router.get('/api/worktrees/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // Default 10, max 50
    const db = req.app.get('db');

    // Get more worktrees than requested to account for stale ones we'll filter out
    const enrichedWorktrees = await query(db, `
      SELECT
        w.id,
        w.repository,
        w.pr_number,
        w.branch,
        w.path,
        w.last_accessed_at,
        w.created_at,
        pm.title as pr_title,
        pm.author,
        pm.head_branch
      FROM worktrees w
      LEFT JOIN pr_metadata pm ON w.pr_number = pm.pr_number AND w.repository = pm.repository
      ORDER BY w.last_accessed_at DESC
      LIMIT ?
    `, [limit * 2]); // Fetch extra to account for stale entries

    // Filter out worktrees where:
    // 1. The directory no longer exists
    // 2. The data is incomplete/corrupted (no author, unknown branch)
    const staleIds = [];
    const validWorktrees = [];

    for (const w of enrichedWorktrees) {
      // Check for corrupted/incomplete data
      if (w.branch === 'unknown' || !w.pr_title || w.pr_title === `PR #${w.pr_number}`) {
        staleIds.push(w.id);
        continue;
      }

      // Check if path still exists
      try {
        await fs.access(w.path);
        validWorktrees.push(w);
      } catch {
        // Path doesn't exist - mark for cleanup
        staleIds.push(w.id);
      }
    }

    // Cleanup stale worktree records in background (don't block response)
    if (staleIds.length > 0) {
      setImmediate(async () => {
        try {
          const placeholders = staleIds.map(() => '?').join(',');
          await run(db, `DELETE FROM worktrees WHERE id IN (${placeholders})`, staleIds);
          logger.info(`Cleaned up ${staleIds.length} stale worktree records`);
        } catch (err) {
          logger.warn(`Failed to cleanup stale worktrees: ${err.message}`);
        }
      });
    }

    // Format the results with fallback values, limited to requested count
    const formattedWorktrees = validWorktrees.slice(0, limit).map(w => ({
      id: w.id,
      repository: w.repository,
      pr_number: w.pr_number,
      pr_title: w.pr_title || `PR #${w.pr_number}`,
      author: w.author || null,
      branch: w.branch,
      head_branch: w.head_branch || w.branch,
      last_accessed_at: w.last_accessed_at,
      created_at: w.created_at
    }));

    res.json({
      success: true,
      worktrees: formattedWorktrees
    });

  } catch (error) {
    console.error('Error fetching recent worktrees:', error);
    res.status(500).json({
      error: 'Failed to fetch recent worktrees'
    });
  }
});

/**
 * Delete a worktree
 * Removes the worktree record from the database and optionally deletes the directory
 */
router.delete('/api/worktrees/:id', async (req, res) => {
  try {
    const worktreeId = req.params.id;

    if (!worktreeId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid worktree ID'
      });
    }

    const db = req.app.get('db');
    const worktreeRepo = new WorktreeRepository(db);

    // Get worktree info before deletion
    const worktree = await queryOne(db, `
      SELECT id, path, pr_number, repository FROM worktrees WHERE id = ?
    `, [worktreeId]);

    if (!worktree) {
      return res.status(404).json({
        success: false,
        error: 'Worktree not found'
      });
    }

    logger.info(`Deleting worktree ID ${worktreeId} for ${worktree.repository} #${worktree.pr_number}`);

    // Delete the worktree directory if it exists
    if (worktree.path) {
      try {
        await fs.access(worktree.path);
        // Directory exists, try to remove it
        await fs.rm(worktree.path, { recursive: true, force: true });
        logger.info(`Deleted worktree directory: ${worktree.path}`);
      } catch (pathError) {
        // Directory doesn't exist or can't be accessed - that's okay
        logger.warn(`Could not delete worktree directory (may not exist): ${worktree.path}`);
      }
    }

    // Delete the worktree record from the database
    await run(db, `DELETE FROM worktrees WHERE id = ?`, [worktreeId]);

    // Also delete associated PR metadata and comments (optional cleanup)
    // Keep PR metadata for now as user might want to reload the PR later
    // await run(db, `DELETE FROM pr_metadata WHERE pr_number = ? AND repository = ?`,
    //   [worktree.pr_number, worktree.repository]);

    logger.success(`Deleted worktree ID ${worktreeId}`);

    res.json({
      success: true,
      message: `Worktree for ${worktree.repository} #${worktree.pr_number} deleted`
    });

  } catch (error) {
    logger.error('Error deleting worktree:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete worktree: ' + error.message
    });
  }
});

/**
 * Get user configuration (for frontend use)
 * Returns safe-to-expose configuration values
 */
router.get('/api/config', (req, res) => {
  const config = req.app.get('config') || {};

  // Only return safe configuration values (not secrets like github_token)
  res.json({
    theme: config.theme || 'light',
    comment_button_action: config.comment_button_action || 'submit'
  });
});

/**
 * Update user configuration
 * Updates safe configuration values
 */
router.patch('/api/config', async (req, res) => {
  try {
    const { comment_button_action } = req.body;

    // Validate comment_button_action if provided
    if (comment_button_action !== undefined) {
      if (!['submit', 'preview'].includes(comment_button_action)) {
        return res.status(400).json({
          error: 'Invalid comment_button_action. Must be "submit" or "preview"'
        });
      }
    }

    // Get current config
    const config = req.app.get('config') || {};

    // Update allowed fields
    if (comment_button_action !== undefined) {
      config.comment_button_action = comment_button_action;
    }

    // Save config to file
    const { saveConfig } = require('../config');
    await saveConfig(config);

    // Update app config
    req.app.set('config', config);

    res.json({
      success: true,
      config: {
        theme: config.theme || 'light',
        comment_button_action: config.comment_button_action || 'submit'
      }
    });

  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({
      error: 'Failed to update configuration'
    });
  }
});

module.exports = router;