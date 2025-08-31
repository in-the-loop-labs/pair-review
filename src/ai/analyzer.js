const ClaudeCLI = require('./claude-cli');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const logger = require('../utils/logger');

class Analyzer {
  constructor(database) {
    this.claude = new ClaudeCLI();
    this.db = database;
  }

  /**
   * Perform Level 1 analysis on a PR
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel1(prId, worktreePath, progressCallback = null) {
    const runId = uuidv4();
    
    logger.section('Level 1 Analysis Starting');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    logger.info(`Worktree path: ${worktreePath}`);
    
    try {
      // Get changed files from PR data for real progress tracking
      const changedFiles = await this.getChangedFiles(prId);
      const totalFiles = changedFiles.length;
      let currentFileIndex = 0;
      
      logger.info(`Found ${totalFiles} changed files to analyze`);
      
      const updateProgress = (step, fileName = null) => {
        const progress = fileName 
          ? `Analyzing ${fileName} (${currentFileIndex + 1}/${totalFiles})...`
          : `${step}...`;
        
        if (progressCallback) {
          progressCallback({
            currentFile: fileName ? currentFileIndex + 1 : 0,
            totalFiles: totalFiles,
            status: 'running',
            progress,
            level: 1
          });
        }
        logger.info(progress);
      };
      
      // Step 1: Prepare analysis
      updateProgress('Preparing analysis');
      
      // Step 2: Build the Level 1 prompt
      updateProgress('Building Level 1 prompt');
      const prompt = this.buildLevel1Prompt(prId, worktreePath);
      
      // Step 3: Simulate analyzing files one by one
      // Since we're doing a single AI call, we'll simulate progress through files
      for (let i = 0; i < changedFiles.length; i++) {
        currentFileIndex = i;
        const fileName = changedFiles[i].file || changedFiles[i].fileName || `File ${i + 1}`;
        updateProgress('Analyzing file', fileName);
        
        // Add a small delay to show progress
        if (i < changedFiles.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      // Step 4: Execute Claude CLI in the worktree directory
      updateProgress('Processing with AI');
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 120000 // 2 minutes for Level 1
      });

      // Step 5: Parse and validate the response
      updateProgress('Processing AI results');
      const suggestions = this.parseResponse(response, 1);
      logger.success(`Parsed ${suggestions.length} valid suggestions`);
      
      // Step 6: Store suggestions in database
      updateProgress('Storing suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 1);
      
      logger.success(`Level 1 analysis complete: ${suggestions.length} suggestions found`);
      
      return {
        runId,
        level: 1,
        suggestions,
        summary: response.summary || `Found ${suggestions.length} suggestions`
      };
    } catch (error) {
      logger.error(`Level 1 analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Build the Level 1 prompt
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   */
  buildLevel1Prompt(prId, worktreePath) {
    return `You are reviewing pull request #${prId} in the worktree at ${worktreePath}.

Perform a Level 1 review focusing ONLY on the changes in the diff:
- Review the git diff to understand what changed
- Identify bugs or errors in the modified code
- Find logic issues in the changes
- Highlight security concerns
- Recognize good practices worth praising

Output JSON with this structure:
{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
}

Focus only on the changed lines. Do not review unchanged code or missing tests (that's for Level 3).`;
  }

  /**
   * Parse Claude's response into structured suggestions
   */
  parseResponse(response, level) {
    // If response is already parsed JSON
    if (response.suggestions && Array.isArray(response.suggestions)) {
      return this.validateSuggestions(response.suggestions);
    }

    // If response is raw text, try to extract JSON
    if (response.raw) {
      try {
        const jsonMatch = response.raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.suggestions) {
            return this.validateSuggestions(parsed.suggestions);
          }
        }
      } catch (error) {
        logger.warn('Failed to extract suggestions from raw response');
      }
    }

    // Fallback to empty array
    logger.warn('No valid suggestions found in response');
    return [];
  }

  /**
   * Validate and filter suggestions
   */
  validateSuggestions(suggestions) {
    return suggestions
      .filter(s => {
        // Ensure required fields exist
        if (!s.file || !s.line || !s.type || !s.title) {
          logger.warn(`Skipping invalid suggestion: ${JSON.stringify(s)}`);
          return false;
        }
        
        // Filter out low confidence suggestions
        if (s.confidence && s.confidence < 0.3) {
          logger.info(`Filtering low confidence suggestion: ${s.title} (${s.confidence})`);
          return false;
        }
        
        return true;
      })
      .map(s => ({
        file: s.file,
        line_start: s.line,
        line_end: s.lineEnd || s.line,
        type: s.type,
        title: s.title,
        description: s.description || '',
        suggestion: s.suggestion || '',
        confidence: s.confidence || 0.7
      }));
  }

  /**
   * Store suggestions in the database
   */
  async storeSuggestions(prId, runId, suggestions, level) {
    const { run } = require('../database');
    
    for (const suggestion of suggestions) {
      const body = suggestion.description + 
        (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');
      
      await run(this.db, `
        INSERT INTO comments (
          pr_id, source, author, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, type, title, body, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        prId,
        'ai',
        'AI Assistant',
        runId,
        level,
        suggestion.confidence,
        suggestion.file,
        suggestion.line_start,
        suggestion.line_end,
        suggestion.type,
        suggestion.title,
        body,
        'active'
      ]);
    }
    
    logger.success(`Stored ${suggestions.length} suggestions in database`);
  }

  /**
   * Get AI suggestions for a PR
   */
  async getSuggestions(prId, runId = null) {
    const { query } = require('../database');
    
    let sql = `
      SELECT * FROM comments 
      WHERE pr_id = ? AND source = 'ai'
    `;
    const params = [prId];

    if (runId) {
      sql += ' AND ai_run_id = ?';
      params.push(runId);
    }

    sql += ' ORDER BY file, line_start';

    return await query(this.db, sql, params);
  }

  /**
   * Get changed files for a PR from database
   * @param {number} prId - Pull request ID
   * @returns {Promise<Array>} Changed files array
   */
  async getChangedFiles(prId) {
    const { queryOne } = require('../database');
    
    try {
      const prMetadata = await queryOne(this.db, `
        SELECT pr_data FROM pr_metadata WHERE id = ?
      `, [prId]);
      
      if (!prMetadata || !prMetadata.pr_data) {
        logger.warn(`No PR data found for PR ID ${prId}`);
        return [];
      }
      
      const prData = JSON.parse(prMetadata.pr_data);
      const changedFiles = prData.changed_files || [];
      
      logger.info(`Found ${changedFiles.length} changed files in PR data`);
      return changedFiles;
    } catch (error) {
      logger.error(`Error getting changed files: ${error.message}`);
      return [];
    }
  }

  /**
   * Perform Level 2 analysis (placeholder for now with real file tracking)
   */
  async analyzeLevel2(prId, worktreePath, progressCallback = null) {
    const changedFiles = await this.getChangedFiles(prId);
    const totalFiles = Math.max(changedFiles.length, 3); // Minimum 3 files for demo
    
    // Simulate Level 2 analysis with file-by-file progress
    for (let i = 0; i < totalFiles; i++) {
      const fileName = changedFiles[i]?.file || `Context analysis ${i + 1}`;
      
      if (progressCallback) {
        progressCallback({
          currentFile: i + 1,
          totalFiles: totalFiles,
          status: 'running',
          progress: `Analyzing context for ${fileName}...`,
          level: 2
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500)); // Simulate work
    }
    
    // Return placeholder result
    return {
      runId: uuidv4(),
      level: 2,
      suggestions: [],
      summary: 'Level 2 analysis complete (placeholder)'
    };
  }

  /**
   * Perform Level 3 analysis (placeholder for now with real file tracking)
   */
  async analyzeLevel3(prId, worktreePath, progressCallback = null) {
    const changedFiles = await this.getChangedFiles(prId);
    const totalFiles = Math.max(changedFiles.length * 2, 5); // More files for architecture analysis
    
    // Simulate Level 3 analysis with file-by-file progress
    for (let i = 0; i < totalFiles; i++) {
      const fileName = i < changedFiles.length 
        ? changedFiles[i].file 
        : `Architecture check ${i + 1 - changedFiles.length}`;
      
      if (progressCallback) {
        progressCallback({
          currentFile: i + 1,
          totalFiles: totalFiles,
          status: 'running',
          progress: `Analyzing architecture impact for ${fileName}...`,
          level: 3
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 300)); // Simulate work
    }
    
    // Return placeholder result
    return {
      runId: uuidv4(),
      level: 3,
      suggestions: [],
      summary: 'Level 3 analysis complete (placeholder)'
    };
  }

  /**
   * Update suggestion status (adopt, dismiss, etc)
   */
  async updateSuggestionStatus(suggestionId, status, adoptedAsId = null) {
    return new Promise((resolve, reject) => {
      const query = adoptedAsId
        ? 'UPDATE comments SET status = ?, adopted_as_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        : 'UPDATE comments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
      
      const params = adoptedAsId 
        ? [status, adoptedAsId, suggestionId]
        : [status, suggestionId];

      this.db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }
}

module.exports = Analyzer;