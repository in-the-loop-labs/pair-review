const express = require('express');
const { query, queryOne, run } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const Analyzer = require('../ai/analyzer');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const router = express.Router();

// Store active analysis runs in memory for status tracking
const activeAnalyses = new Map();

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
        created_at: prMetadata.created_at,
        updated_at: prMetadata.updated_at,
        file_changes: extendedData.changed_files ? extendedData.changed_files.length : 0,
        additions: extendedData.additions || 0,
        deletions: extendedData.deletions || 0,
        diff_content: extendedData.diff || ''
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

    res.json({
      diff: prData.diff || '',
      changed_files: prData.changed_files || [],
      stats: {
        additions: prData.additions || 0,
        deletions: prData.deletions || 0,
        changed_files: prData.changed_files || 0
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

    const worktreeManager = new GitWorktreeManager();
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
 * Trigger AI analysis for a PR
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
    const prMetadata = await queryOne(req.app.get('db'), `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({ 
        error: `Pull request #${prNumber} not found. Please load the PR first.` 
      });
    }

    // Get worktree path
    const worktreeManager = new GitWorktreeManager();
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
    activeAnalyses.set(analysisId, {
      id: analysisId,
      prNumber,
      repository,
      status: 'running',
      level: 1,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 1 analysis...'
    });

    // Create analyzer instance
    const analyzer = new Analyzer(req.app.get('db'));
    
    // Log analysis start with colorful output
    logger.section(`AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Worktree: ${worktreePath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    
    // Start analysis asynchronously
    analyzer.analyzeLevel1(prMetadata.id, worktreePath)
      .then(result => {
        logger.section('Analysis Results');
        logger.success(`Analysis complete for PR #${prNumber}`);
        logger.success(`Found ${result.suggestions.length} suggestions:`);
        result.suggestions.forEach(s => {
          const icon = s.type === 'bug' ? '🐛' : 
                       s.type === 'praise' ? '👍' :
                       s.type === 'improvement' ? '💡' :
                       s.type === 'security' ? '🔒' :
                       s.type === 'performance' ? '⚡' : '📝';
          logger.log('Result', `${icon} ${s.type}: ${s.title} (${s.file}:${s.line_start})`, 'green');
        });
        
        activeAnalyses.set(analysisId, {
          ...activeAnalyses.get(analysisId),
          status: 'completed',
          completedAt: new Date().toISOString(),
          result,
          progress: `Analysis complete: ${result.suggestions.length} suggestions found`
        });
      })
      .catch(error => {
        logger.error(`Analysis failed for PR #${prNumber}: ${error.message}`);
        activeAnalyses.set(analysisId, {
          ...activeAnalyses.get(analysisId),
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Analysis failed'
        });
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
 * Get AI suggestions for a PR
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

    // Get AI suggestions from the new comments table (include dismissed ones too)
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
      WHERE pr_id = ? AND source = 'ai' AND status IN ('active', 'dismissed')
      ORDER BY file, line_start
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
 * Update AI suggestion status (adopt/dismiss)
 */
router.post('/api/ai-suggestion/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userComment } = req.body;
    
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

    let adoptedAsId = null;
    
    // If adopting, create a user comment
    if (status === 'adopted') {
      const commentBody = userComment || suggestion.body;
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
        commentBody,
        'active'
      ]);
      
      adoptedAsId = result.lastID;
    }

    // Update suggestion status
    // When restoring to active, we need to clear adopted_as_id
    if (status === 'active') {
      await run(db, `
        UPDATE comments 
        SET status = ?, adopted_as_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, id]);
    } else {
      await run(db, `
        UPDATE comments 
        SET status = ?, adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [status, adoptedAsId, id]);
    }

    res.json({ 
      success: true,
      status,
      adoptedAsId 
    });
    
  } catch (error) {
    console.error('Error updating suggestion status:', error);
    res.status(500).json({ 
      error: 'Failed to update suggestion status' 
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

module.exports = router;