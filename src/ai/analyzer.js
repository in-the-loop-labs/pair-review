const ClaudeCLI = require('./claude-cli');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('../utils/logger');

class Analyzer {
  constructor(database) {
    this.claude = new ClaudeCLI();
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

# Level 2 Review - Analyze File Context

## Previous Analysis Context
Level 1 analysis found ${previousSuggestions.length} suggestions:
${previousSuggestions.map(s => `- ${s.type}: ${s.title} (${s.file}:${s.line_start})`).join('\n')}

## Analysis Process
1. Run 'git diff origin/${prMetadata.base_branch}...HEAD --name-only' to identify changed files
2. For each changed file:
   - Read the full file content to understand context
   - Run 'git diff origin/${prMetadata.base_branch}...HEAD <file>' to see what changed
   - Analyze how changes fit within the file's overall structure

## Focus Areas (Building on Level 1 findings)
// USER_CUSTOMIZABLE: File Consistency Patterns
Look for:
   - Inconsistencies within files (naming conventions, patterns, error handling)
   - Missing related changes within files (if one part changed, what else should change?)
   
// USER_CUSTOMIZABLE: Code Style Preferences
   - Code style violations or deviations from patterns established in the file
   - Consistent formatting and structure within files
   
// USER_CUSTOMIZABLE: Architecture Patterns  
   - Opportunities for improvement based on full file context
   - Design pattern consistency within file scope
   
// USER_CUSTOMIZABLE: Best Practices Recognition
   - Good practices worth praising in the file's context

## Available Commands
You have full access to the codebase and can run commands like:
- git diff origin/${prMetadata.base_branch}...HEAD --name-only
- git diff origin/${prMetadata.base_branch}...HEAD <file>
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

# Level 1 Review - Analyze Changes in Isolation

## Initial Setup
1. Run 'git diff origin/${prMetadata.base_branch}...HEAD' to see what changed in this PR
2. Focus ONLY on the changed lines in the diff

## Analysis Focus Areas
// USER_CUSTOMIZABLE: Code Quality Checks
Identify the following in changed code:
   - Bugs or errors in the modified code
   - Logic issues in the changes
   
// USER_CUSTOMIZABLE: Security Analysis
   - Security concerns and vulnerabilities
   
// USER_CUSTOMIZABLE: Performance Analysis  
   - Performance issues and optimizations
   
// USER_CUSTOMIZABLE: Code Style Preferences
   - Code style and formatting issues
   - Naming convention violations
   
// USER_CUSTOMIZABLE: Architecture Patterns
   - Design pattern violations visible in isolation
   
// USER_CUSTOMIZABLE: Best Practices Recognition
   - Good practices worth praising

## Available Commands
You have full access to the codebase and can run commands like:
- git diff origin/${prMetadata.base_branch}...HEAD
- git diff --stat
- git show HEAD
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
            return this.validateSuggestions(parsed.suggestions, previousSuggestions);
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
   * @param {Array} suggestions - Raw suggestions from AI
   * @param {Array} previousSuggestions - Previous suggestions to check for duplicates
   */
  validateSuggestions(suggestions, previousSuggestions = []) {
    const validSuggestions = suggestions
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
   * Detect testing context for the codebase
   * @param {string} worktreePath - Path to the git worktree
   * @returns {Promise<Object>} Testing context information
   */
  async detectTestingContext(worktreePath) {
    // Check cache first
    if (this.testContextCache.has(worktreePath)) {
      return this.testContextCache.get(worktreePath);
    }

    logger.info('Detecting testing context for codebase');
    
    try {
      // Step 1: Detect primary language(s) from changed files
      const { stdout: changedFiles } = await execPromise('git diff origin/HEAD...HEAD --name-only', { cwd: worktreePath });
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
      
      // Step 1: Detect testing context
      updateProgress('Detecting testing context for codebase');
      const testingContext = await this.detectTestingContext(worktreePath);
      
      // Step 2: Build the Level 3 prompt with test context
      updateProgress('Building Level 3 prompt for Claude to analyze codebase impact');
      const prompt = this.buildLevel3Prompt(prId, worktreePath, prMetadata, previousSuggestions, testingContext);
      
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

  buildLevel3Prompt(prId, worktreePath, prMetadata, previousSuggestions = [], testingContext = null) {
    return `You are reviewing pull request #${prId} in the current working directory.

# Level 3 Review - Analyze Codebase Context

## Previous Analysis Context
Previous levels found ${previousSuggestions.length} suggestions:
${previousSuggestions.map(s => `- ${s.type}: ${s.title} (${s.file}:${s.line_start || s.line})`).join('\n')}

## Analysis Process
Focus on architectural and cross-file concerns not visible in single-file context.
Skip exploration of unchanged areas unless directly impacted by the changes.

Based on the changed files identified in previous levels, explore the codebase to understand architectural context:
   - Find and examine related files (imports, tests, configs)
   - Look for similar patterns elsewhere in the codebase
   - Check for related documentation

## Focus Areas (Building on Previous Findings)
// USER_CUSTOMIZABLE: Architecture Patterns
Analyze:
   - Architectural consistency across the codebase
   - Pattern violations or inconsistencies with established patterns
   - Cross-file dependencies and potential impact
   
// USER_CUSTOMIZABLE: Test Coverage Analysis
   ${this.buildTestAnalysisSection(testingContext)}
   
// USER_CUSTOMIZABLE: Documentation Standards
   - Missing or outdated documentation
   - API documentation consistency
   
// USER_CUSTOMIZABLE: Configuration Management  
   - Configuration changes needed
   - Environment-specific considerations
   
// USER_CUSTOMIZABLE: Compatibility Analysis
   - Potential breaking changes or compatibility issues
   - Backward compatibility concerns
   
// USER_CUSTOMIZABLE: Performance Analysis
   - Cross-component performance implications
   - Scalability considerations
   
// USER_CUSTOMIZABLE: Security Checks
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
- Do NOT duplicate findings from earlier levels - avoid duplicating the suggestions listed above
- Look especially for ${testingContext?.shouldCheckTests ? 'missing tests,' : ''} documentation, and architectural issues
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