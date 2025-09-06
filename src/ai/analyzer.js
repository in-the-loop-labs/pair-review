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
   * Delete old AI suggestions for a PR
   * @param {number} prId - Pull request ID
   */
  async deleteOldAISuggestions(prId) {
    const { run } = require('../database');
    
    try {
      const result = await run(this.db, `
        DELETE FROM comments 
        WHERE pr_id = ? AND source = 'ai'
      `, [prId]);
      
      if (result.changes > 0) {
        logger.info(`Deleted ${result.changes} old AI suggestions for PR ${prId}`);
      }
      
      return result.changes;
    } catch (error) {
      logger.error(`Error deleting old AI suggestions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Perform Level 1 analysis on a PR
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel1(prId, worktreePath, prMetadata, progressCallback = null) {
    const runId = uuidv4();
    
    logger.section('Level 1 Analysis Starting');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    logger.info(`Worktree path: ${worktreePath}`);
    
    try {
      const updateProgress = (step) => {
        const progress = `Level 1: ${step}...`;
        
        if (progressCallback) {
          progressCallback({
            status: 'running',
            progress,
            level: 1
          });
        }
        logger.info(progress);
      };
      
      // Step 1: Delete old AI suggestions before starting new analysis
      updateProgress('Clearing previous AI suggestions');
      await this.deleteOldAISuggestions(prId);
      
      // Step 2: Build the Level 1 prompt
      updateProgress('Building Level 1 prompt for Claude to analyze changes');
      const prompt = this.buildLevel1Prompt(prId, worktreePath, prMetadata);
      
      // Step 3: Execute Claude CLI in the worktree directory
      updateProgress('Running Claude to analyze changes in isolation');
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000 // 10 minutes for Level 1 - let Claude be thorough
      });

      // Step 4: Parse and validate the response
      updateProgress('Processing AI results');
      const suggestions = this.parseResponse(response, 1);
      logger.success(`Parsed ${suggestions.length} valid suggestions`);
      
      // Step 5: Store suggestions in database
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
        
        level2Result = await this.analyzeLevel2(prId, worktreePath, prMetadata, suggestions, level2ProgressCallback);
        logger.success(`Level 2 analysis complete: ${level2Result.suggestions.length} additional suggestions found`);
        
        // After Level 2 completes, automatically start Level 3
        try {
          logger.info('Starting Level 3 analysis automatically...');
          
          // Create separate progress callback for Level 3 that properly reports level
          const level3ProgressCallback = progressCallback ? (progressUpdate) => {
            progressCallback({
              ...progressUpdate,
              level: 3
            });
          } : null;
          
          const level3Result = await this.analyzeLevel3(prId, worktreePath, prMetadata, [...suggestions, ...level2Result.suggestions], level3ProgressCallback);
          logger.success(`Level 3 analysis complete: ${level3Result.suggestions.length} additional suggestions found`);
          
          // Add level 3 result to the return object
          level2Result.level3Result = level3Result;
        } catch (level3Error) {
          logger.warn(`Level 3 analysis failed, but Level 1 and Level 2 results are still available: ${level3Error.message}`);
        }
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
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} previousSuggestions - Previous level suggestions to avoid duplicating
   */
  buildLevel2Prompt(prId, worktreePath, prMetadata, previousSuggestions = []) {
    return `You are reviewing pull request #${prId} in the current working directory.

Perform a Level 2 review - analyze file context:

1. Run 'git diff origin/${prMetadata.base_branch}...HEAD --name-only' to identify changed files
2. For each changed file:
   - Read the full file content to understand context
   - Run 'git diff origin/${prMetadata.base_branch}...HEAD <file>' to see what changed
   - Analyze how changes fit within the file's overall structure
3. Look for:
   - Inconsistencies within files (naming conventions, patterns, error handling)
   - Missing related changes within files (if one part changed, what else should change?)
   - Code style violations or deviations from patterns established in the file
   - Opportunities for improvement based on full file context
   - Good practices worth praising in the file's context

You have full access to the codebase and can run commands like:
- git diff origin/${prMetadata.base_branch}...HEAD --name-only
- git diff origin/${prMetadata.base_branch}...HEAD <file>
- cat <file> or any file reading command
- grep, find, ls commands as needed

Note: You may optionally use parallel read-only Tasks to examine multiple files simultaneously if that would be helpful.

Output JSON with this structure:
{
  "level": 2,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve based on file context (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of file context findings"
}

Previous findings from earlier analysis levels:
${previousSuggestions.map(s => `- ${s.type}: ${s.title} (${s.file}:${s.line_start})`).join('\n')}

Important:
- Only attach suggestions to lines that were ADDED or MODIFIED in this PR
- Focus on issues that require understanding the full file context
- Do NOT duplicate findings from earlier levels - avoid duplicating the suggestions listed above
- If you find an issue on an unchanged line, mention it but attach to the nearest changed line
- For "praise" type: Omit the suggestion field entirely to save tokens
- For other types: Include specific, actionable suggestions`;
  }


  /**
   * Build the Level 1 prompt
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   */
  buildLevel1Prompt(prId, worktreePath, prMetadata) {
    return `You are reviewing pull request #${prId} in the current working directory.

Perform a Level 1 review - analyze changes in isolation:

1. Run 'git diff origin/${prMetadata.base_branch}...HEAD' to see what changed in this PR
2. Focus ONLY on the changed lines in the diff
3. Identify:
   - Bugs or errors in the modified code
   - Logic issues in the changes
   - Security concerns
   - Good practices worth praising
   - Performance issues
   - Code style and formatting issues

You have full access to the codebase and can run commands like:
- git diff origin/${prMetadata.base_branch}...HEAD
- git diff --stat
- git show HEAD
- ls, find, grep commands as needed

Note: You may optionally use parallel Tasks to analyze different parts of the changes if that would be helpful.

Output JSON with this structure:
{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve (omit this field for praise items - no action needed)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
}

Category definitions:
- bug: Errors, crashes, or incorrect behavior
- improvement: Enhancements to make existing code better
- praise: Good practices worth highlighting
- suggestion: General recommendations to consider
- design: Architecture and structural concerns
- performance: Speed and efficiency optimizations
- security: Vulnerabilities or safety issues
- code-style: Formatting, naming conventions, and code style

Important: 
- Only comment on lines that were actually changed in this PR
- Focus on issues visible in the diff itself
- Do not review unchanged code or missing tests (that's for Level 3)
- For "praise" type suggestions: Omit the suggestion field entirely (no action needed)
- For other types: Include specific, actionable suggestions
- This saves tokens and prevents empty suggestion sections`;
  }

  /**
   * Parse Claude's response into structured suggestions
   * @param {Object} response - Claude's response
   * @param {number} level - Analysis level
   * @param {Array} previousSuggestions - Previous suggestions to check for duplicates
   */
  parseResponse(response, level, previousSuggestions = []) {
    // If response is already parsed JSON
    if (response.suggestions && Array.isArray(response.suggestions)) {
      return this.validateSuggestions(response.suggestions, previousSuggestions);
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
   * Perform Level 2 analysis - File Context
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} level1Suggestions - Previous Level 1 suggestions to avoid duplicating
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel2(prId, worktreePath, prMetadata, level1Suggestions = [], progressCallback = null) {
    const runId = uuidv4();
    
    logger.section('Level 2 Analysis Starting');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    logger.info(`Worktree path: ${worktreePath}`);
    
    try {
      const updateProgress = (step) => {
        const progress = `Level 2: ${step}...`;
        
        if (progressCallback) {
          progressCallback({
            status: 'running',
            progress,
            level: 2
          });
        }
        logger.info(progress);
      };
      
      // Step 1: Build the Level 2 prompt
      updateProgress('Building Level 2 prompt for Claude to analyze changes at file level');
      const prompt = this.buildLevel2Prompt(prId, worktreePath, prMetadata, level1Suggestions);
      
      // Step 2: Execute Claude CLI in the worktree directory (single invocation)
      updateProgress('Running Claude to analyze all changed files in context');
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000 // 10 minutes for Level 2 - analyze all files in one go
      });
      
      // Step 3: Parse and validate the response
      updateProgress('Processing AI results');
      const suggestions = this.parseResponse(response, 2, level1Suggestions);
      logger.success(`Parsed ${suggestions.length} valid Level 2 suggestions`);
      
      // Step 4: Store Level 2 suggestions in database
      updateProgress('Storing Level 2 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 2);
      
      logger.success(`Level 2 analysis complete: ${suggestions.length} suggestions found`);
      
      return {
        runId,
        level: 2,
        suggestions,
        summary: response.summary || `Level 2 analysis complete: Found ${suggestions.length} file context suggestions`
      };
      
    } catch (error) {
      logger.error(`Level 2 analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Perform Level 3 analysis - Codebase Context
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} previousSuggestions - Previous Level 1 and Level 2 suggestions to avoid duplicating
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel3(prId, worktreePath, prMetadata, previousSuggestions = [], progressCallback = null) {
    const runId = uuidv4();
    
    logger.section('Level 3 Analysis Starting');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    logger.info(`Worktree path: ${worktreePath}`);
    
    try {
      const updateProgress = (step) => {
        const progress = `Level 3: ${step}...`;
        
        if (progressCallback) {
          progressCallback({
            status: 'running',
            progress,
            level: 3
          });
        }
        logger.info(progress);
      };
      
      // Step 1: Build the Level 3 prompt
      updateProgress('Building Level 3 prompt for Claude to analyze codebase impact');
      const prompt = this.buildLevel3Prompt(prId, worktreePath, prMetadata, previousSuggestions);
      
      // Step 2: Execute Claude CLI for Level 3 analysis
      updateProgress('Running Claude to analyze codebase-wide implications');
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 900000 // 15 minutes for Level 3 - full codebase exploration
      });
      
      // Step 3: Parse and validate the response
      updateProgress('Processing codebase context results');
      const suggestions = this.parseResponse(response, 3, previousSuggestions);
      logger.success(`Parsed ${suggestions.length} valid Level 3 suggestions`);
      
      // Step 4: Store Level 3 suggestions in database
      updateProgress('Storing Level 3 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 3);
      
      logger.success(`Level 3 analysis complete: ${suggestions.length} suggestions found`);
      
      return {
        runId,
        level: 3,
        suggestions,
        summary: response.summary || `Level 3 analysis complete: Found ${suggestions.length} codebase context suggestions`
      };
      
    } catch (error) {
      logger.error(`Level 3 analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Build the Level 3 prompt for codebase context analysis
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} previousSuggestions - Previous level suggestions to avoid duplicating
   */
  buildLevel3Prompt(prId, worktreePath, prMetadata, previousSuggestions = []) {
    return `You are reviewing pull request #${prId} in the current working directory.

Perform a Level 3 review - analyze codebase context:

1. Run 'git diff origin/${prMetadata.base_branch}...HEAD --name-only' to see what files changed
2. Explore the codebase to understand architectural context:
   - Find and examine related files (imports, tests, configs)
   - Look for similar patterns elsewhere in the codebase
   - Check for related documentation
3. Analyze:
   - Architectural consistency across the codebase
   - Missing tests for the changed functionality
   - Missing or outdated documentation
   - Pattern violations or inconsistencies with established patterns
   - Cross-file dependencies and potential impact
   - Configuration changes needed
   - Potential breaking changes or compatibility issues

You have full access to the codebase and can run commands like:
- git diff origin/${prMetadata.base_branch}...HEAD
- find . -name "*.test.js" or similar to find test files
- grep -r "pattern" to search for patterns
- cat, ls, tree commands to explore structure
- Any other commands needed to understand the codebase

Note: You may optionally use parallel Tasks to explore different areas of the codebase if that would be helpful.

Output JSON with this structure:
{
  "level": 3,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why codebase context was needed",
    "suggestion": "How to fix/improve based on codebase context (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of codebase context findings"
}

Previous findings from earlier analysis levels:
${previousSuggestions.map(s => `- ${s.type}: ${s.title} (${s.file}:${s.line_start || s.line})`).join('\n')}

Important:
- Only attach suggestions to lines that were ADDED or MODIFIED in this PR
- Focus on codebase-wide concerns that require understanding multiple files
- Do NOT duplicate findings from earlier levels - avoid duplicating the suggestions listed above
- Look especially for missing tests, documentation, and architectural issues
- For "praise" type: Omit the suggestion field entirely to save tokens
- For other types: Include specific, actionable suggestions`;
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