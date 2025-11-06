const ClaudeCLI = require('./claude-cli');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

class Analyzer {
  constructor(database, model = 'sonnet') {
    this.claude = new ClaudeCLI(model);
    this.db = database;
    this.testContextCache = new Map(); // Cache test detection results per worktree
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
      logger.success(`Parsed ${suggestions.length} valid Level 1 suggestions`);

      // Store Level 1 suggestions
      updateProgress('Storing Level 1 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 1);
      logger.success(`Level 1 analysis complete: ${suggestions.length} suggestions found and stored`);

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
        
        level2Result = await this.analyzeLevel2(prId, worktreePath, prMetadata, level2ProgressCallback);
        logger.success(`Level 2 analysis complete: ${level2Result.suggestions.length} additional suggestions found`);

        // Store Level 2 suggestions
        updateProgress('Storing Level 2 suggestions in database');
        await this.storeSuggestions(prId, runId, level2Result.suggestions, 2);

        // After Level 2 completes, automatically start Level 3
        let level3Result = null;
        try {
          logger.info('Starting Level 3 analysis automatically...');
          
          // Create separate progress callback for Level 3 that properly reports level
          const level3ProgressCallback = progressCallback ? (progressUpdate) => {
            progressCallback({
              ...progressUpdate,
              level: 3
            });
          } : null;
          
          level3Result = await this.analyzeLevel3(prId, worktreePath, prMetadata, level3ProgressCallback);
          logger.success(`Level 3 analysis complete: ${level3Result.suggestions.length} additional suggestions found`);

          // Store Level 3 suggestions
          updateProgress('Storing Level 3 suggestions in database');
          await this.storeSuggestions(prId, runId, level3Result.suggestions, 3);
        } catch (level3Error) {
          logger.warn(`Level 3 analysis failed, but Level 1 and Level 2 results are still available: ${level3Error.message}`);
        }
        
        // Now orchestrate all suggestions before storing
        updateProgress('Orchestrating AI suggestions for intelligent curation');
        try {
          const allSuggestions = {
            level1: suggestions,
            level2: level2Result.suggestions,
            level3: level3Result?.suggestions || []
          };
          
          const orchestratedSuggestions = await this.orchestrateWithAI(allSuggestions, prMetadata);

          // Store only the orchestrated results with ai_level = NULL (final suggestions)
          updateProgress('Storing orchestrated suggestions in database');
          await this.storeSuggestions(prId, runId, orchestratedSuggestions, null);
          
          // Update the return object with orchestrated results
          level2Result.level3Result = level3Result;
          level2Result.orchestratedSuggestions = orchestratedSuggestions;
          
        } catch (orchestrationError) {
          logger.error(`Orchestration failed: ${orchestrationError.message}`);
          logger.warn('Falling back to storing all original suggestions');
          
          // Store all original suggestions with level labels as fallback
          updateProgress('Storing fallback suggestions in database');
          const fallbackSuggestions = [];
          
          suggestions.forEach(s => {
            fallbackSuggestions.push(s);
          });
          
          if (level2Result?.suggestions) {
            level2Result.suggestions.forEach(s => {
              fallbackSuggestions.push(s);
            });
          }
          
          if (level3Result?.suggestions) {
            level3Result.suggestions.forEach(s => {
              fallbackSuggestions.push(s);
            });
          }
          
          await this.storeSuggestions(prId, runId, fallbackSuggestions, null);
          level2Result.orchestratedSuggestions = fallbackSuggestions;
        }
        
      } catch (level2Error) {
        logger.warn(`Level 2 analysis failed, storing Level 1 results only: ${level2Error.message}`);
        
        // Store only Level 1 suggestions if Level 2 fails
        updateProgress('Storing Level 1 suggestions in database');
        // Store Level 1 suggestions without level labels
        await this.storeSuggestions(prId, runId, suggestions, 1);
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
   */
  buildLevel2Prompt(prId, worktreePath, prMetadata) {
    return `You are reviewing pull request #${prId} in the current working directory.

# Level 2 Review - Analyze File Context

## Analysis Process
For each file with changes:
   - Read the full file content to understand context
   - Run 'git diff ${prMetadata.base_sha}...${prMetadata.head_sha} <file>' to see what changed
   - Analyze how changes fit within the file's overall structure
   - Focus on file-level patterns and consistency
   - Skip files where no file-level issues are found (efficiency focus)

## Focus Areas
Look for:
   - Inconsistencies within files (naming conventions, patterns, error handling)
   - Missing related changes within files (if one part changed, what else should change?)
   - File-level security patterns and vulnerabilities
   - Security consistency within the file scope
   - Code style violations or deviations from patterns established in the file
   - Consistent formatting and structure within files
   - Opportunities for improvement based on full file context
   - Design pattern consistency within file scope
   - File-level documentation completeness and consistency
   - Missing documentation for file-level changes
   - Good practices worth praising in the file's context

## Available Commands
You have full access to the codebase and can run commands like:
- git diff ${prMetadata.base_sha}...${prMetadata.head_sha} <file>
- cat <file> or any file reading command
- grep, find, ls commands as needed

Note: You may optionally use parallel read-only Tasks to examine multiple files simultaneously if that would be helpful.

## Output Format
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

## Important Guidelines
- Only attach suggestions to lines that were ADDED or MODIFIED in this PR
- Focus on issues that require understanding the full file context
- Focus on file-level patterns and consistency
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

# Level 1 Review - Analyze Changes in Isolation

## Speed and Scope Expectations
**This level should be fast** - focusing only on the diff itself without exploring file context or surrounding unchanged code. That analysis is reserved for Level 2.

## Initial Setup
1. Run 'git diff ${prMetadata.base_sha}...${prMetadata.head_sha}' to see what changed in this PR
2. Focus ONLY on the changed lines in the diff
3. Do not analyze file context or surrounding unchanged code - that's for Level 2

## Analysis Focus Areas
Identify the following in changed code:
   - Bugs or errors in the modified code
   - Logic issues in the changes
   - Security concerns and vulnerabilities in the changed lines
   - Performance issues and optimizations visible in the diff
   - Code style and formatting issues
   - Naming convention violations
   - Design pattern violations visible in isolation
   - Documentation issues visible in the changed lines
   - Good practices worth praising

## Available Commands
You have full access to the codebase and can run commands like:
- git diff ${prMetadata.base_sha}...${prMetadata.head_sha}
- git diff --stat
- ls, find, grep commands as needed

Note: You may optionally use parallel Tasks to analyze different parts of the changes if that would be helpful.

## Output Format
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

## Category Definitions
- bug: Errors, crashes, or incorrect behavior
- improvement: Enhancements to make existing code better
- praise: Good practices worth highlighting
- suggestion: General recommendations to consider
- design: Architecture and structural concerns
- performance: Speed and efficiency optimizations
- security: Vulnerabilities or safety issues
- code-style: Formatting, naming conventions, and code style

## Important Guidelines
- Only comment on lines that were actually changed in this PR
- Focus on issues visible in the diff itself - do not analyze file context
- Do not review unchanged code or missing tests (that's for Level 3)
- Do not analyze file-level patterns or consistency (that's for Level 2)
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

    // If response is raw text, try multiple extraction strategies
    if (response.raw) {
      const extracted = extractJSON(response.raw);
      if (extracted.success && extracted.data.suggestions && Array.isArray(extracted.data.suggestions)) {
        return this.validateSuggestions(extracted.data.suggestions, previousSuggestions);
      } else {
        logger.warn(`JSON extraction failed: ${extracted.error}`);
        logger.info(`Raw response length: ${response.raw.length} characters`);
        logger.info(`Raw response preview: ${response.raw.substring(0, 500)}...`);
      }
    }

    // Fallback to empty array
    logger.warn('No valid suggestions found in response');
    return [];
  }

  /**
   * Validate and filter suggestions
   * @param {Array} suggestions - Raw suggestions from AI
   * @param {Array} previousSuggestions - Previous suggestions to check for duplicates
   */
  validateSuggestions(suggestions, previousSuggestions = []) {
    const validSuggestions = suggestions
      .map(s => {
        // Normalize: Some models (like Haiku) use 'description' instead of 'title'
        // If title is missing but description exists, extract first line as title
        if (!s.title && s.description) {
          // Extract first line or sentence as title (max 150 chars)
          const firstLine = s.description.split(/[.\n]/)[0].trim();
          const title = firstLine.length > 150
            ? firstLine.substring(0, 147) + '...'
            : firstLine;

          return {
            ...s,
            title: title,
            description: s.description // Keep full description
          };
        }
        return s;
      })
      .filter(s => {
        // Ensure required fields exist after normalization
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
      });
    
    // Deduplicate against previous suggestions
    const deduplicatedSuggestions = this.deduplicateSuggestions(validSuggestions, previousSuggestions);
    
    return deduplicatedSuggestions
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
   * Deduplicate suggestions against previous suggestions
   * @param {Array} newSuggestions - New suggestions to check
   * @param {Array} previousSuggestions - Previous suggestions to compare against
   * @returns {Array} Filtered suggestions with duplicates removed
   */
  deduplicateSuggestions(newSuggestions, previousSuggestions) {
    if (!previousSuggestions || previousSuggestions.length === 0) {
      return newSuggestions;
    }
    
    return newSuggestions.filter(newSugg => {
      // Check for exact duplicates based on file, line, and type
      const hasExactMatch = previousSuggestions.some(prevSugg => 
        prevSugg.file === newSugg.file && 
        prevSugg.line_start === newSugg.line &&
        prevSugg.type === newSugg.type
      );
      
      if (hasExactMatch) {
        // Check text similarity for final deduplication
        const hasSimilarText = previousSuggestions.some(prevSugg => {
          if (prevSugg.file === newSugg.file && 
              prevSugg.line_start === newSugg.line &&
              prevSugg.type === newSugg.type) {
            const similarity = this.calculateTextSimilarity(
              prevSugg.title + ' ' + prevSugg.description,
              newSugg.title + ' ' + (newSugg.description || '')
            );
            return similarity > 0.8; // 80% similarity threshold
          }
          return false;
        });
        
        if (hasSimilarText) {
          logger.info(`Filtering duplicate suggestion: ${newSugg.title} (${newSugg.file}:${newSugg.line})`);
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Calculate text similarity between two strings using Levenshtein distance
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity ratio between 0 and 1
   */
  calculateTextSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    // Normalize strings (lowercase, trim)
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    
    const maxLength = Math.max(s1.length, s2.length);
    if (maxLength === 0) return 1;
    
    const distance = this.levenshteinDistance(s1, s2);
    return (maxLength - distance) / maxLength;
  }

  /**
   * Calculate Levenshtein distance between two strings
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Edit distance
   */
  levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Store suggestions in the database
   */
  async storeSuggestions(prId, runId, suggestions, level) {
    const { run } = require('../database');
    
    for (const suggestion of suggestions) {
      const body = suggestion.description + 
        (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');
      
      // Handle different level types including orchestrated
      const aiLevel = typeof level === 'string' ? level : level;
      
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
        aiLevel,
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
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel2(prId, worktreePath, prMetadata, progressCallback = null) {
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
      const prompt = this.buildLevel2Prompt(prId, worktreePath, prMetadata);

      // Step 2: Execute Claude CLI in the worktree directory (single invocation)
      updateProgress('Running Claude to analyze all changed files in context');
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000 // 10 minutes for Level 2 - analyze all files in one go
      });

      // Step 3: Parse and validate the response
      updateProgress('Processing AI results');
      const suggestions = this.parseResponse(response, 2);
      logger.success(`Parsed ${suggestions.length} valid Level 2 suggestions`);
      
      // Keep suggestions in memory - do not store yet (orchestration will handle storage)
      
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
   * Detect testing context for the codebase
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @returns {Promise<Object>} Testing context information
   */
  async detectTestingContext(worktreePath, prMetadata) {
    // Check cache first
    if (this.testContextCache.has(worktreePath)) {
      return this.testContextCache.get(worktreePath);
    }

    logger.info('Detecting testing context for codebase');

    try {
      // Step 1: Detect primary language(s) from changed files
      const { stdout: changedFiles } = await execPromise(`git diff ${prMetadata.base_sha}...${prMetadata.head_sha} --name-only`, { cwd: worktreePath });
      const files = changedFiles.trim().split('\n').filter(f => f.length > 0);
      
      const languages = this.detectLanguages(files);
      logger.info(`Detected languages: ${languages.join(', ')}`);
      
      // Step 2: Check for language-specific test patterns
      let hasTests = false;
      let testFramework = null;
      const testFiles = [];
      
      // Check for test files based on detected languages
      for (const lang of languages) {
        const patterns = this.getTestPatterns(lang);
        
        for (const pattern of patterns) {
          try {
            const { stdout: foundFiles } = await execPromise(
              `find . -name "${pattern}" -type f | head -20`, 
              { cwd: worktreePath }
            );
            
            if (foundFiles.trim()) {
              hasTests = true;
              testFiles.push(...foundFiles.trim().split('\n').filter(f => f.length > 0));
              
              // Determine test framework
              if (!testFramework) {
                testFramework = this.determineTestFramework(lang, foundFiles, worktreePath);
              }
            }
          } catch (error) {
            // Continue if pattern search fails
            logger.debug(`Test pattern search failed for ${pattern}: ${error.message}`);
          }
        }
      }
      
      // Step 3: Check if PR itself modifies test files
      const prModifiesTests = files.some(file => 
        this.isTestFile(file) || testFiles.some(testFile => testFile.includes(file))
      );
      
      // Step 4: Determine if we should check for tests
      const shouldCheckTests = hasTests || prModifiesTests;
      
      const result = {
        hasTests,
        testFramework,
        shouldCheckTests,
        testFiles: testFiles.slice(0, 10), // Limit to first 10 for logging
        languages,
        prModifiesTests
      };
      
      logger.info(`Test detection result: hasTests=${hasTests}, framework=${testFramework}, shouldCheck=${shouldCheckTests}`);
      
      // Cache the result
      this.testContextCache.set(worktreePath, result);
      
      return result;
    } catch (error) {
      logger.warn(`Test detection failed: ${error.message}`);
      // Fallback - assume we should check tests
      const fallbackResult = {
        hasTests: true,
        testFramework: null,
        shouldCheckTests: true,
        testFiles: [],
        languages: ['javascript'], // Safe default
        prModifiesTests: false
      };
      
      this.testContextCache.set(worktreePath, fallbackResult);
      return fallbackResult;
    }
  }
  
  /**
   * Detect primary languages from file extensions
   * @param {Array<string>} files - List of file paths
   * @returns {Array<string>} Detected languages
   */
  detectLanguages(files) {
    const extensionMap = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rb': 'ruby',
      '.rs': 'rust',
      '.php': 'php',
      '.cs': 'csharp',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c'
    };
    
    const languageCount = {};
    
    files.forEach(file => {
      const ext = path.extname(file).toLowerCase();
      const lang = extensionMap[ext];
      if (lang) {
        languageCount[lang] = (languageCount[lang] || 0) + 1;
      }
    });
    
    // Return languages sorted by frequency
    return Object.entries(languageCount)
      .sort(([,a], [,b]) => b - a)
      .map(([lang]) => lang);
  }
  
  /**
   * Get test file patterns for a language
   * @param {string} language - Programming language
   * @returns {Array<string>} Test file patterns
   */
  getTestPatterns(language) {
    const patterns = {
      javascript: ['*.test.js', '*.spec.js', '__tests__/*.js'],
      typescript: ['*.test.ts', '*.spec.ts', '*.test.tsx', '*.spec.tsx', '__tests__/*.ts', '__tests__/*.tsx'],
      python: ['test_*.py', '*_test.py', 'test*.py'],
      java: ['*Test.java', '*Tests.java'],
      go: ['*_test.go'],
      ruby: ['*_spec.rb', '*_test.rb'],
      rust: ['**/tests/*.rs'],
      php: ['*Test.php', '*_test.php'],
      csharp: ['*Test.cs', '*Tests.cs'],
      cpp: ['*_test.cpp', '*Test.cpp'],
      c: ['*_test.c', '*Test.c']
    };
    
    return patterns[language] || [];
  }
  
  /**
   * Determine test framework based on found files and codebase inspection
   * @param {string} language - Programming language
   * @param {string} foundFiles - Found test files
   * @param {string} worktreePath - Path to worktree
   * @returns {string|null} Test framework name
   */
  determineTestFramework(language, foundFiles, worktreePath) {
    // Framework detection based on common patterns
    const frameworkIndicators = {
      javascript: {
        jest: ['jest.config.js', 'package.json'],
        mocha: ['mocha.opts', '.mocharc'],
        jasmine: ['jasmine.json'],
        vitest: ['vitest.config'],
        cypress: ['cypress.json', 'cypress/'],
        playwright: ['playwright.config']
      },
      python: {
        pytest: ['pytest.ini', 'pyproject.toml'],
        unittest: ['unittest'],
        nose: ['.noserc'],
        tox: ['tox.ini']
      },
      java: {
        junit: ['pom.xml', 'build.gradle'],
        testng: ['testng.xml']
      },
      go: {
        testing: ['go.mod'] // Go's built-in testing
      },
      ruby: {
        rspec: ['spec/', '.rspec'],
        minitest: ['test/']
      },
      rust: {
        cargo: ['Cargo.toml']
      }
    };
    
    const indicators = frameworkIndicators[language];
    if (!indicators) return null;
    
    // Check for framework indicator files (simplified check)
    for (const [framework, files] of Object.entries(indicators)) {
      for (const file of files) {
        try {
          // Simple heuristic - if the indicator mentions the framework or common patterns
          if (foundFiles.includes(file) || foundFiles.includes(framework)) {
            return framework;
          }
        } catch (error) {
          // Continue checking other indicators
        }
      }
    }
    
    // Default frameworks for each language
    const defaults = {
      javascript: 'jest',
      typescript: 'jest', 
      python: 'pytest',
      java: 'junit',
      go: 'testing',
      ruby: 'rspec',
      rust: 'cargo'
    };
    
    return defaults[language] || null;
  }
  
  /**
   * Check if a file is a test file based on common patterns
   * @param {string} filePath - Path to the file
   * @returns {boolean} True if the file appears to be a test file
   */
  isTestFile(filePath) {
    const fileName = path.basename(filePath).toLowerCase();
    const fullPath = filePath.toLowerCase();
    
    // Common test file patterns
    const testPatterns = [
      /\.test\./,
      /\.spec\./,
      /_test\./,
      /test_.*\./,
      /.*test\./, 
      /.*tests\./
    ];
    
    // Test directory patterns (check full path)
    const testDirPatterns = [
      /\/test\//,
      /\/tests\//,
      /\/spec\//,
      /\/specs\//,
      /\/__tests__\//,
      /\/cypress\//,
      /\/playwright\//,
      // Handle paths without leading slash
      /^test\//,
      /^tests\//,
      /^spec\//,
      /^specs\//,
      /^__tests__\//,
      /^cypress\//,
      /^playwright\//
    ];
    
    return testPatterns.some(pattern => pattern.test(fileName)) ||
           testDirPatterns.some(pattern => pattern.test(fullPath));
  }

  /**
   * Perform Level 3 analysis - Codebase Context
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel3(prId, worktreePath, prMetadata, progressCallback = null) {
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
      
      // Step 1: Detect testing context
      updateProgress('Detecting testing context for codebase');
      const testingContext = await this.detectTestingContext(worktreePath, prMetadata);

      // Step 2: Build the Level 3 prompt with test context
      updateProgress('Building Level 3 prompt for Claude to analyze codebase impact');
      const prompt = this.buildLevel3Prompt(prId, worktreePath, prMetadata, testingContext);

      // Step 2: Execute Claude CLI for Level 3 analysis
      updateProgress('Running Claude to analyze codebase-wide implications');
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 900000 // 15 minutes for Level 3 - full codebase exploration
      });

      // Step 3: Parse and validate the response
      updateProgress('Processing codebase context results');
      const suggestions = this.parseResponse(response, 3);
      logger.success(`Parsed ${suggestions.length} valid Level 3 suggestions`);
      
      // Keep suggestions in memory - do not store yet (orchestration will handle storage)
      
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
   * @param {Object} testingContext - Testing context information
   */
  /**
   * Build the test analysis section for Level 3 prompt
   * @param {Object} testingContext - Testing context information
   * @returns {string} Test analysis section
   */
  buildTestAnalysisSection(testingContext) {
    if (!testingContext) {
      return `- Missing tests for the changed functionality (checking enabled by default)`;
    }
    
    if (testingContext.shouldCheckTests) {
      const frameworkNote = testingContext.testFramework 
        ? ` (detected framework: ${testingContext.testFramework})`
        : '';
      
      return `- Missing tests for the changed functionality${frameworkNote}
   // Test checking: enabled based on codebase analysis - found test files: ${testingContext.hasTests}`;
    } else {
      return `// Test checking: disabled based on codebase analysis - no test framework detected
   // Skipping test coverage analysis as no test framework detected in codebase`;
    }
  }

  buildLevel3Prompt(prId, worktreePath, prMetadata, testingContext = null) {
    return `You are reviewing pull request #${prId} in the current working directory.

# Level 3 Review - Analyze Codebase Context

## Analysis Process
Focus on architectural and cross-file concerns not visible in single-file context.
Skip exploration of unchanged areas unless directly impacted by the changes.

Identify changed files and explore the codebase to understand architectural context:
   - Find and examine related files (imports, tests, configs)
   - Look for similar patterns elsewhere in the codebase
   - Check for related documentation

## Focus Areas
Analyze:
   - Architectural consistency across the codebase
   - Pattern violations or inconsistencies with established patterns
   - Cross-file dependencies and potential impact
   - ${this.buildTestAnalysisSection(testingContext)}
   - Missing or outdated documentation
   - API documentation consistency
   - Configuration changes needed
   - Environment-specific considerations
   - Potential breaking changes or compatibility issues
   - Backward compatibility concerns
   - Cross-component performance implications
   - Scalability considerations
   - Cross-system security implications
   - Data flow security analysis

## Available Commands
You have full access to the codebase and can run commands like:
- find . -name "*.test.js" or similar to find test files
- grep -r "pattern" to search for patterns
- cat, ls, tree commands to explore structure
- Any other commands needed to understand the codebase

Note: You may optionally use parallel Tasks to explore different areas of the codebase if that would be helpful.

## Output Format
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

## Important Guidelines
- Only attach suggestions to lines that were ADDED or MODIFIED in this PR
- Focus on codebase-wide concerns that require understanding multiple files
- Look especially for ${testingContext?.shouldCheckTests ? 'missing tests,' : ''} documentation, and architectural issues
- For "praise" type: Omit the suggestion field entirely to save tokens
- For other types: Include specific, actionable suggestions`;
  }

  /**
   * Orchestrate all suggestions using AI to provide intelligent curation and merging
   * @param {Object} allSuggestions - Object containing suggestions from all levels: {level1: [...], level2: [...], level3: [...]}
   * @param {Object} prMetadata - PR metadata for context
   * @returns {Promise<Array>} Curated suggestions array
   */
  async orchestrateWithAI(allSuggestions, prMetadata) {
    logger.section('AI Orchestration Starting');
    
    const totalSuggestions = (allSuggestions.level1?.length || 0) + 
                           (allSuggestions.level2?.length || 0) + 
                           (allSuggestions.level3?.length || 0);
    
    logger.info(`Orchestrating ${totalSuggestions} total suggestions across all levels`);
    
    try {
      // Build the orchestration prompt
      const prompt = this.buildOrchestrationPrompt(allSuggestions, prMetadata);
      
      // Execute Claude CLI for orchestration
      logger.info('Running AI orchestration to curate and merge suggestions...');
      const response = await this.claude.execute(prompt, {
        timeout: 300000 // 5 minutes for orchestration
      });
      
      // Parse the orchestrated response
      const orchestratedSuggestions = this.parseResponse(response, 'orchestrated');
      logger.success(`AI orchestration complete: ${orchestratedSuggestions.length} curated suggestions`);
      
      return orchestratedSuggestions;
      
    } catch (error) {
      logger.warn(`AI orchestration failed: ${error.message}`);
      logger.warn('Falling back to storing all original suggestions');
      
      // Fallback: combine all suggestions with level labels
      const fallbackSuggestions = [];
      
      if (allSuggestions.level1) {
        allSuggestions.level1.forEach(s => {
          fallbackSuggestions.push(s);
        });
      }
      
      if (allSuggestions.level2) {
        allSuggestions.level2.forEach(s => {
          fallbackSuggestions.push(s);
        });
      }
      
      if (allSuggestions.level3) {
        allSuggestions.level3.forEach(s => {
          fallbackSuggestions.push(s);
        });
      }
      
      return fallbackSuggestions;
    }
  }

  /**
   * Build orchestration prompt for intelligent suggestion curation
   * @param {Object} allSuggestions - Suggestions from all levels
   * @param {Object} prMetadata - PR metadata for context
   * @returns {string} Orchestration prompt
   */
  buildOrchestrationPrompt(allSuggestions, prMetadata) {
    const level1Count = allSuggestions.level1?.length || 0;
    const level2Count = allSuggestions.level2?.length || 0; 
    const level3Count = allSuggestions.level3?.length || 0;
    
    return `You are orchestrating AI-powered code review suggestions for pull request #${prMetadata.number}.

# AI Suggestion Orchestration Task

## CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

## Your Role
You are helping a human reviewer by intelligently curating and merging suggestions from a 3-level analysis system. Your goal is to provide the most valuable, non-redundant guidance to accelerate the human review process.

## Input: Multi-Level Analysis Results
**Level 1 - Diff Analysis (${level1Count} suggestions):**
${allSuggestions.level1 ? allSuggestions.level1.map(s => 
  `- ${s.type}: ${s.title} (${s.file}:${s.line_start}) - ${s.description.substring(0, 100)}...`
).join('\n') : 'No Level 1 suggestions'}

**Level 2 - File Context (${level2Count} suggestions):**
${allSuggestions.level2 ? allSuggestions.level2.map(s => 
  `- ${s.type}: ${s.title} (${s.file}:${s.line_start}) - ${s.description.substring(0, 100)}...`
).join('\n') : 'No Level 2 suggestions'}

**Level 3 - Codebase Context (${level3Count} suggestions):**
${allSuggestions.level3 ? allSuggestions.level3.map(s => 
  `- ${s.type}: ${s.title} (${s.file}:${s.line_start}) - ${s.description.substring(0, 100)}...`
).join('\n') : 'No Level 3 suggestions'}

## Orchestration Guidelines

### 1. Intelligent Merging
- **Combine related suggestions** across levels into comprehensive insights
- **Merge overlapping concerns** (e.g., same security issue found in multiple levels)
- **Preserve unique insights** that only one level discovered
- **Do NOT mention which level found the issue** - focus on the insight itself

### 2. Priority-Based Curation
Prioritize suggestions in this order:
1. **Security vulnerabilities** - Critical safety issues
2. **Bugs and errors** - Functional correctness issues  
3. **Architecture concerns** - Design and structural issues
4. **Performance optimizations** - Efficiency improvements
5. **Code style** - Formatting and convention issues

### 3. Balanced Output
- **Limit praise suggestions** to 2-3 most noteworthy items
- **Focus on actionable items** that provide clear value to reviewer
- **Avoid suggestion overload** - aim for quality over quantity
- **Include confidence scores** based on cross-level agreement

### 4. Human-Centric Framing
- Frame suggestions as **considerations and guidance**, not mandates
- Use language like "Consider...", "You might want to review...", "Worth noting..."
- **Preserve reviewer autonomy** - you're a pair programming partner, not an enforcer
- **Provide context** for why each suggestion matters to the reviewer

## Output Format
Output ONLY the JSON object below with no additional text before or after. Do NOT use markdown code blocks or explanations:

{
  "level": "orchestrated",
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing the curated insight",
    "description": "Clear explanation of the issue and why this guidance matters to the human reviewer",
    "suggestion": "Specific, actionable guidance for the reviewer (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of orchestration results and key patterns found"
}

## Important Notes
- **Quality over quantity** - Better to have 8 excellent suggestions than 20 mediocre ones
- **Cross-level validation** - Higher confidence for issues found in multiple levels
- **Preserve actionability** - Every suggestion should give clear next steps
- **Maintain context** - Don't lose important details when merging
- **Only comment on changed lines** - Attach suggestions only to lines modified in this PR`;
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