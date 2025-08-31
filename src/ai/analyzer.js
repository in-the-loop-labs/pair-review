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
      
      // After Level 1 completes, automatically start Level 2
      let level2Result = null;
      try {
        logger.info('Starting Level 2 analysis automatically...');
        
        // Create separate progress callback for Level 2 that properly reports level
        const level2ProgressCallback = progressCallback ? (progressUpdate) => {
          progressCallback({
            ...progressUpdate,
            level: 2
          });
        } : null;
        
        level2Result = await this.analyzeLevel2(prId, worktreePath, level2ProgressCallback);
        logger.success(`Level 2 analysis complete: ${level2Result.suggestions.length} additional suggestions found`);
      } catch (level2Error) {
        logger.warn(`Level 2 analysis failed, but Level 1 results are still available: ${level2Error.message}`);
      }
      
      return {
        runId,
        level: 1,
        suggestions,
        summary: response.summary || `Found ${suggestions.length} suggestions`,
        level2Result
      };
    } catch (error) {
      logger.error(`Level 1 analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Build the Level 2 prompt for file context analysis
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} fileInfo - File information including content
   */
  buildLevel2Prompt(prId, worktreePath, fileInfo) {
    return `You are performing Level 2 review (File Context) for pull request #${prId}.

File being analyzed: ${fileInfo.fileName}
File path: ${fileInfo.filePath}
File size: ${fileInfo.lineCount} lines

Full file content:
\`\`\`
${fileInfo.content}
\`\`\`

Level 2 Focus - File Context Analysis:
- Look for inconsistencies within this single file (naming conventions, patterns, error handling)
- Identify missing related changes within this file (if one part changed, what else should change?)
- Check for style violations or deviations from patterns established in this file
- Find opportunities for improvement based on the full context of this file
- Highlight good practices worth praising in this file's context

IMPORTANT: Only suggest issues that require understanding the full file context.
Do NOT duplicate Level 1 findings that could be found just by looking at the diff.

Output JSON with this structure:
{
  "level": 2,
  "suggestions": [{
    "file": "${fileInfo.fileName}",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security|style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve based on file context",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of file context findings"
}

Focus on file-level consistency and context that wasn't visible in just the diff.`;
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
   * Perform Level 2 analysis - File Context
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel2(prId, worktreePath, progressCallback = null) {
    const runId = uuidv4();
    
    logger.section('Level 2 Analysis Starting');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    logger.info(`Worktree path: ${worktreePath}`);
    
    try {
      // Get changed files from PR data
      const changedFiles = await this.getChangedFiles(prId);
      const totalFiles = changedFiles.length;
      let currentFileIndex = 0;
      
      logger.info(`Found ${totalFiles} changed files to analyze at file level`);
      
      const updateProgress = (step, fileName = null) => {
        const progress = fileName 
          ? `Level 2: Analyzing file context for ${fileName} (${currentFileIndex + 1}/${totalFiles})...`
          : `Level 2: ${step}...`;
        
        if (progressCallback) {
          progressCallback({
            currentFile: fileName ? currentFileIndex + 1 : 0,
            totalFiles: totalFiles,
            status: 'running',
            progress,
            level: 2
          });
        }
        logger.info(progress);
      };
      
      // Step 1: Prepare Level 2 analysis
      updateProgress('Preparing file context analysis');
      
      // Filter out files that are too large (>10,000 lines)
      const analyzeableFiles = [];
      let suggestions = [];
      
      for (let i = 0; i < changedFiles.length; i++) {
        currentFileIndex = i;
        const fileInfo = changedFiles[i];
        const fileName = fileInfo.file || fileInfo.fileName || `File ${i + 1}`;
        
        updateProgress('Checking file size', fileName);
        
        try {
          const filePath = require('path').join(worktreePath, fileName);
          const fs = require('fs').promises;
          
          // Check if file exists and get its content
          const stats = await fs.stat(filePath).catch(() => null);
          if (!stats || stats.isDirectory()) {
            logger.warn(`Skipping ${fileName}: not a regular file`);
            continue;
          }
          
          const content = await fs.readFile(filePath, 'utf8');
          const lines = content.split('\n');
          
          if (lines.length > 10000) {
            logger.info(`Skipping ${fileName}: too large (${lines.length} lines > 10,000 limit)`);
            continue;
          }
          
          analyzeableFiles.push({
            ...fileInfo,
            fileName,
            filePath,
            content,
            lineCount: lines.length
          });
          
        } catch (error) {
          logger.warn(`Error checking file ${fileName}: ${error.message}`);
        }
      }
      
      logger.info(`${analyzeableFiles.length} files eligible for Level 2 analysis`);
      
      if (analyzeableFiles.length === 0) {
        logger.info('No files eligible for Level 2 analysis');
        return {
          runId,
          level: 2,
          suggestions: [],
          summary: 'Level 2 analysis complete: No files eligible for analysis'
        };
      }
      
      // Step 2: Analyze each file with context
      for (let i = 0; i < analyzeableFiles.length; i++) {
        currentFileIndex = i;
        const fileInfo = analyzeableFiles[i];
        
        updateProgress('Analyzing file context', fileInfo.fileName);
        
        try {
          // Build Level 2 prompt for this file
          const prompt = this.buildLevel2Prompt(prId, worktreePath, fileInfo);
          
          // Execute Claude CLI for this file
          const response = await this.claude.execute(prompt, {
            cwd: worktreePath,
            timeout: 90000 // 1.5 minutes per file
          });
          
          // Parse the response for this file
          const fileSuggestions = this.parseResponse(response, 2);
          suggestions = suggestions.concat(fileSuggestions);
          
          logger.info(`Found ${fileSuggestions.length} Level 2 suggestions for ${fileInfo.fileName}`);
          
          // Add small delay between files to show progress
          if (i < analyzeableFiles.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          
        } catch (error) {
          logger.warn(`Level 2 analysis failed for ${fileInfo.fileName}: ${error.message}`);
          // Continue with other files even if one fails
        }
      }
      
      logger.success(`Parsed ${suggestions.length} valid Level 2 suggestions`);
      
      // Step 3: Store Level 2 suggestions in database
      updateProgress('Storing Level 2 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 2);
      
      logger.success(`Level 2 analysis complete: ${suggestions.length} suggestions found`);
      
      return {
        runId,
        level: 2,
        suggestions,
        summary: `Level 2 analysis complete: Found ${suggestions.length} file context suggestions`
      };
      
    } catch (error) {
      logger.error(`Level 2 analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
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