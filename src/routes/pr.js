const express = require('express');
const { query, queryOne } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const fs = require('fs').promises;
const path = require('path');

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