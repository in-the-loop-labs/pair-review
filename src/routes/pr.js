const express = require('express');
const { query, queryOne, run } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const Analyzer = require('../ai/analyzer');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const router = express.Router();

// Store active analysis runs in memory for status tracking
const activeAnalyses = new Map();

// Store SSE clients for real-time progress updates
const progressClients = new Map();

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
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'started',
      level: 1,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 1 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);
    
    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance
    const analyzer = new Analyzer(req.app.get('db'));
    
    // Log analysis start with colorful output
    logger.section(`AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Worktree: ${worktreePath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    
    // Update status to running and broadcast
    setTimeout(() => {
      const runningStatus = {
        ...activeAnalyses.get(analysisId),
        status: 'running',
        progress: 'Analyzing diff hunks...'
      };
      activeAnalyses.set(analysisId, runningStatus);
      broadcastProgress(analysisId, runningStatus);
    }, 1000);

    // Create progress callback function
    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        // Don't override the level if it's already set in progressUpdate
        level: progressUpdate.level || 1
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };
    
    // Start analysis asynchronously with progress callback
    analyzer.analyzeLevel1(prMetadata.id, worktreePath, progressCallback)
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
                       s.type === 'design' ? '🎨' :
                       s.type === 'suggestion' ? '💬' :
                       s.type === 'code-style' || s.type === 'style' ? '📐' : '📝';
          logger.log('Result', `${icon} ${s.type}: ${s.title} (${s.file}:${s.line_start})`, 'green');
        });
        
        // Determine completed levels based on result
        const completedLevel = result.level2Result ? 2 : 1;
        const totalSuggestions = result.suggestions.length + (result.level2Result?.suggestions?.length || 0);
        
        const completedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'completed',
          level: completedLevel,
          completedLevel: completedLevel,
          completedAt: new Date().toISOString(),
          result,
          progress: `Analysis complete: ${totalSuggestions} suggestions found (Level 1: ${result.suggestions.length}${result.level2Result ? `, Level 2: ${result.level2Result.suggestions.length}` : ''}${result.level2Result && result.level2Result.level3Result ? `, Level 3: ${result.level2Result.level3Result.suggestions.length}` : ''})`,
          filesAnalyzed: totalSuggestions,
          filesRemaining: 0,
          currentFile: totalSuggestions,
          totalFiles: totalSuggestions
        };
        activeAnalyses.set(analysisId, completedStatus);
        
        // Broadcast completion status
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        logger.error(`Analysis failed for PR #${prNumber}: ${error.message}`);
        const failedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'failed',
          level: 1,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);
        
        // Broadcast failure status
        broadcastProgress(analysisId, failedStatus);
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
    
    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance
    const analyzer = new Analyzer(req.app.get('db'));
    
    logger.section(`Level 2 AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');

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
    analyzer.analyzeLevel2(prMetadata.id, worktreePath, progressCallback)
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
    
    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance
    const analyzer = new Analyzer(req.app.get('db'));
    
    logger.section(`Level 3 AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');

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
    analyzer.analyzeLevel3(prMetadata.id, worktreePath, progressCallback)
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
    const { pr_id, file, line_start, line_end, diff_position, body, parent_id, type, title } = req.body;
    
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
    const result = await run(db, `
      INSERT INTO comments (
        pr_id, source, author, file, line_start, line_end, diff_position,
        type, title, body, status, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      pr_id,
      'user',
      'Current User', // TODO: Get actual user from session/config
      file,
      line_start,
      line_end || line_start,
      diff_position || null,  // Store diff position for GitHub API
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
 * Submit review to GitHub
 */
router.post('/api/pr/:owner/:repo/:number/submit-review', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const { event, body } = req.body; // event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    const prNumber = parseInt(number);
    
    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({ 
        error: 'Invalid pull request number' 
      });
    }

    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event)) {
      return res.status(400).json({ 
        error: 'Invalid review event. Must be APPROVE, REQUEST_CHANGES, or COMMENT' 
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
        diff_position
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
    const worktreeManager = new GitWorktreeManager();
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });
    
    let diffContent = '';
    try {
      diffContent = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    } catch (diffError) {
      console.warn('Could not generate diff for position calculation:', diffError.message);
      // Continue without diff - GitHub client will handle missing positions
    }

    // Format comments for GitHub API
    // GitHubClient expects: path, line, body, and optionally diff_position
    const githubComments = comments.map(comment => ({
      path: comment.file,      // file path
      line: comment.line_start, // line number in the file (fallback)
      body: comment.body,       // comment text
      diff_position: comment.diff_position  // stored diff position from UI
    }));

    // Begin database transaction for submission tracking
    await run(db, 'BEGIN TRANSACTION');
    
    try {
      // Submit review to GitHub
      console.log(`Submitting review for PR #${prNumber} with ${comments.length} comments`);
      const githubReview = await githubClient.createReview(
        owner, 
        repo, 
        prNumber, 
        event, 
        body || '', 
        githubComments, 
        diffContent
      );

      // Update reviews table with submission status
      const now = new Date().toISOString();
      await run(db, `
        INSERT OR REPLACE INTO reviews (pr_number, repository, status, updated_at, submitted_at, review_data)
        VALUES (?, ?, 'submitted', ?, ?, ?)
      `, [prNumber, repository, now, now, JSON.stringify({
        github_review_id: githubReview.id,
        github_url: githubReview.html_url,
        event: event,
        body: body || '',
        comments_count: githubReview.comments_count,
        submitted_at: githubReview.submitted_at
      })]);

      // Update comments table to mark submitted comments
      // Note: Since comments table doesn't have github-specific columns in current schema,
      // we'll update the status to indicate submission
      for (const comment of comments) {
        await run(db, `
          UPDATE comments 
          SET status = 'submitted', updated_at = ?
          WHERE id = ?
        `, [now, comment.id]);
      }

      // Commit transaction
      await run(db, 'COMMIT');

      console.log(`Review submitted successfully: ${githubReview.html_url}`);

      res.json({ 
        success: true,
        message: `Review submitted successfully to GitHub`,
        github_url: githubReview.html_url,
        github_review_id: githubReview.id,
        comments_submitted: githubReview.comments_count,
        event: event
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