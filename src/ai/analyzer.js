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
        timeout: 600000 // 10 minutes for Level 1 - let Claude be thorough
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
          
          const level3Result = await this.analyzeLevel3(prId, worktreePath, level3ProgressCallback);
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
   * @param {Object} fileInfo - File information including content
   */
  buildLevel2Prompt(prId, worktreePath, fileInfo) {
    // Get the changed line numbers from the diff
    const changedLines = fileInfo.changedLines || this.extractChangedLines(fileInfo);
    const changedLinesStr = changedLines.length > 0 
      ? `Changed lines in this file: ${changedLines.join(', ')}`
      : 'Unable to determine changed lines';

    return `You are performing Level 2 review (File Context) for pull request #${prId}.

File being analyzed: ${fileInfo.fileName}
File path: ${fileInfo.filePath}
File size: ${fileInfo.lineCount} lines
${changedLinesStr}

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

CRITICAL REQUIREMENT: Only attach suggestions to lines that were ADDED or MODIFIED in this PR.
The changed lines are listed above. You MUST only use line numbers from that list in your suggestions.
If you find an issue on an unchanged line, mention it in the description but attach the suggestion to the nearest changed line.

IMPORTANT: Only suggest issues that require understanding the full file context.
Do NOT duplicate Level 1 findings that could be found just by looking at the diff.

Output JSON with this structure:
{
  "level": 2,
  "suggestions": [{
    "file": "${fileInfo.fileName}",
    "line": <MUST be a line number from the changed lines list>,
    "type": "bug|improvement|praise|suggestion|design|performance|security|style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve based on file context",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of file context findings"
}

Focus on file-level consistency and context that wasn't visible in just the diff.
Remember: Only use line numbers that were actually changed in this PR.`;
  }

  /**
   * Extract changed line numbers from file info
   * @param {Object} fileInfo - File information
   * @returns {Array<number>} Array of changed line numbers
   */
  extractChangedLines(fileInfo) {
    const changedLines = [];
    
    // Try to get from git diff
    try {
      const { execSync } = require('child_process');
      const fileName = fileInfo.fileName;
      
      // Get the diff for this specific file to extract line numbers
      const diff = execSync(`git diff HEAD~1 HEAD -- "${fileName}" 2>/dev/null || true`, {
        cwd: fileInfo.filePath ? require('path').dirname(fileInfo.filePath) : process.cwd(),
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      
      // Parse diff to extract added/modified line numbers
      const lines = diff.split('\n');
      let currentLine = 0;
      
      for (const line of lines) {
        // Look for hunk headers like @@ -1,3 +1,5 @@
        if (line.startsWith('@@')) {
          const match = line.match(/@@ -\d+,?\d* \+(\d+),?(\d*) @@/);
          if (match) {
            currentLine = parseInt(match[1]) - 1;
          }
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          // This is an added line
          currentLine++;
          changedLines.push(currentLine);
        } else if (!line.startsWith('-')) {
          // Context line
          currentLine++;
        }
      }
    } catch (error) {
      logger.warn(`Could not extract changed lines for ${fileInfo.fileName}: ${error.message}`);
    }
    
    // If we couldn't get from diff, estimate from additions/deletions
    if (changedLines.length === 0 && fileInfo.insertions > 0) {
      // As a fallback, assume all lines are potentially changed
      // This is not accurate but better than nothing
      logger.info(`Using fallback: marking first ${fileInfo.insertions} lines as changed`);
      for (let i = 1; i <= Math.min(fileInfo.insertions, fileInfo.lineCount || 100); i++) {
        changedLines.push(i);
      }
    }
    
    return changedLines;
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
          
          // Only skip truly impractical files
          if (lines.length > 100000) {
            logger.info(`Skipping ${fileName}: extremely large (${lines.length} lines)`);
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
            timeout: 300000 // 5 minutes per file - allow thorough analysis
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
   * Perform Level 3 analysis - Codebase Context
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Function} progressCallback - Callback for progress updates
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel3(prId, worktreePath, progressCallback = null) {
    const runId = uuidv4();
    
    logger.section('Level 3 Analysis Starting');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    logger.info(`Worktree path: ${worktreePath}`);
    
    try {
      // Get changed files from PR data
      const changedFiles = await this.getChangedFiles(prId);
      
      const updateProgress = (step, fileName = null, currentIdx = 0, totalFiles = 0) => {
        const progress = fileName 
          ? `Level 3: Analyzing codebase context for ${fileName} (${currentIdx}/${totalFiles})...`
          : `Level 3: ${step}...`;
        
        if (progressCallback) {
          progressCallback({
            currentFile: currentIdx,
            totalFiles: totalFiles,
            status: 'running',
            progress,
            level: 3
          });
        }
        logger.info(progress);
      };
      
      // Step 1: Prepare Level 3 analysis
      updateProgress('Preparing codebase context analysis');
      
      // Step 2: Discover related files
      updateProgress(`Discovering related files - scanning for imports, tests, configs, and dependencies across the codebase`);
      const relatedFiles = await this.discoverRelatedFiles(worktreePath, changedFiles);
      
      logger.info(`Found ${relatedFiles.length} related files for Level 3 analysis`);
      
      if (relatedFiles.length === 0) {
        logger.info('No related files found for Level 3 analysis');
        return {
          runId,
          level: 3,
          suggestions: [],
          summary: 'Level 3 analysis complete: No related files to analyze'
        };
      }
      
      // Step 3: Build Level 3 prompt with related files context
      updateProgress('Building codebase context prompt');
      const prompt = await this.buildLevel3Prompt(prId, worktreePath, changedFiles, relatedFiles);
      
      // Step 4: Execute Claude CLI for Level 3 analysis
      updateProgress('Analyzing codebase context with AI', null, 1, 1);
      const response = await this.claude.execute(prompt, {
        cwd: worktreePath,
        timeout: 900000 // 15 minutes for Level 3 - full codebase exploration
      });
      
      // Step 5: Parse and validate the response
      updateProgress('Processing codebase context results');
      const suggestions = this.parseResponse(response, 3);
      logger.success(`Parsed ${suggestions.length} valid Level 3 suggestions`);
      
      // Step 6: Store Level 3 suggestions in database
      updateProgress('Storing Level 3 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 3);
      
      logger.success(`Level 3 analysis complete: ${suggestions.length} suggestions found`);
      
      return {
        runId,
        level: 3,
        suggestions,
        summary: `Level 3 analysis complete: Found ${suggestions.length} codebase context suggestions`
      };
      
    } catch (error) {
      logger.error(`Level 3 analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Discover related files for Level 3 codebase context analysis
   * @param {string} worktreePath - Path to the git worktree
   * @param {Array} changedFiles - Array of changed files from PR
   * @returns {Promise<Array>} Array of related files with content
   */
  async discoverRelatedFiles(worktreePath, changedFiles) {
    const fs = require('fs').promises;
    const path = require('path');
    const relatedFiles = new Set();
    // No artificial limit on related files - analyze what's relevant
    
    logger.info(`Discovering all related files for ${changedFiles.length} changed files - no artificial limits`);
    
    try {
      // For each changed file, find related files
      for (const fileInfo of changedFiles) {
        const fileName = fileInfo.file || fileInfo.fileName;
        if (!fileName) continue;
        
        const filePath = path.join(worktreePath, fileName);
        
        try {
          // Check if file exists and is readable
          const stats = await fs.stat(filePath).catch(() => null);
          if (!stats || stats.isDirectory()) continue;
          
          const content = await fs.readFile(filePath, 'utf8');
          
          // 1. Find imported/required modules
          const imports = this.extractImports(content, fileName);
          for (const importPath of imports) {
            const resolvedPath = this.resolveImportPath(importPath, fileName, worktreePath);
            if (resolvedPath) {
              relatedFiles.add(resolvedPath);
            }
          }
          
          // 2. Find test files
          const testFiles = this.findTestFiles(fileName, worktreePath);
          for (const testFile of testFiles) {
            relatedFiles.add(testFile);
          }
          
          // 3. Find files that import this file
          const importingFiles = await this.findImportingFiles(fileName, worktreePath);
          for (const importingFile of importingFiles) {
            relatedFiles.add(importingFile);
          }
          
        } catch (error) {
          logger.warn(`Error analyzing file ${fileName}: ${error.message}`);
        }
        
        // No artificial limit on related files - analyze what's relevant
      }
      
      // 4. Add configuration files
      const configFiles = await this.findConfigFiles(worktreePath);
      for (const configFile of configFiles) {
        relatedFiles.add(configFile);
      }
      
      // Convert Set to Array and read file contents
      const relatedFilesArray = Array.from(relatedFiles);
      const relatedFilesWithContent = [];
      
      for (const relatedFile of relatedFilesArray) {
        try {
          const stats = await fs.stat(relatedFile).catch(() => null);
          if (!stats || stats.isDirectory()) continue;
          
          const content = await fs.readFile(relatedFile, 'utf8');
          const lines = content.split('\n');
          
          // Only skip extremely large files that would be impractical
          if (lines.length > 100000) {
            logger.info(`Skipping extremely large file ${relatedFile}: ${lines.length} lines`);
            continue;
          }
          
          const relativePath = path.relative(worktreePath, relatedFile);
          relatedFilesWithContent.push({
            path: relatedFile,
            relativePath,
            content,
            lineCount: lines.length
          });
          
        } catch (error) {
          logger.warn(`Error reading related file ${relatedFile}: ${error.message}`);
        }
      }
      
      logger.info(`Successfully loaded ${relatedFilesWithContent.length} related files`);
      return relatedFilesWithContent;
      
    } catch (error) {
      logger.error(`Error discovering related files: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Extract import/require statements from file content
   */
  extractImports(content, fileName) {
    const imports = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
      // JavaScript/Node.js requires
      const requireMatch = line.match(/require\s*\(\s*['""]([^'"'"]+)['"]\s*\)/);
      if (requireMatch) {
        imports.push(requireMatch[1]);
      }
      
      // ES6 imports
      const importMatch = line.match(/import.*from\s+['""]([^'"'"]+)["']/);
      if (importMatch) {
        imports.push(importMatch[1]);
      }
      
      // Dynamic imports
      const dynamicImportMatch = line.match(/import\s*\(\s*['""]([^'"'"]+)['"]\s*\)/);
      if (dynamicImportMatch) {
        imports.push(dynamicImportMatch[1]);
      }
    }
    
    return imports.filter(imp => {
      // Filter out external modules (those that don't start with . or /)
      return imp.startsWith('.') || imp.startsWith('/');
    });
  }
  
  /**
   * Resolve import path to actual file path
   */
  resolveImportPath(importPath, fromFile, worktreePath) {
    const path = require('path');
    
    try {
      const fromDir = path.dirname(path.join(worktreePath, fromFile));
      let resolvedPath;
      
      if (importPath.startsWith('.')) {
        // Relative import
        resolvedPath = path.resolve(fromDir, importPath);
      } else if (importPath.startsWith('/')) {
        // Absolute import (relative to worktree)
        resolvedPath = path.join(worktreePath, importPath);
      } else {
        // Module import - skip external modules
        return null;
      }
      
      // Try different extensions
      const extensions = ['', '.js', '.json', '/index.js'];
      for (const ext of extensions) {
        const fullPath = resolvedPath + ext;
        const fs = require('fs');
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Find test files related to a given file
   */
  findTestFiles(fileName, worktreePath) {
    const path = require('path');
    const fs = require('fs');
    const testFiles = [];
    
    const baseName = path.basename(fileName, path.extname(fileName));
    const dirName = path.dirname(fileName);
    
    // Common test file patterns
    const testPatterns = [
      `${baseName}.test.js`,
      `${baseName}.spec.js`,
      `${baseName}.test.json`,
      `${baseName}.spec.json`,
      `test/${baseName}.js`,
      `tests/${baseName}.js`,
      `__tests__/${baseName}.js`,
      `__tests__/${baseName}.test.js`
    ];
    
    for (const pattern of testPatterns) {
      const testPath = path.join(worktreePath, dirName, pattern);
      const altTestPath = path.join(worktreePath, pattern);
      
      if (fs.existsSync(testPath)) {
        testFiles.push(testPath);
      } else if (fs.existsSync(altTestPath)) {
        testFiles.push(altTestPath);
      }
    }
    
    return testFiles;
  }
  
  /**
   * Find files that import the given file
   */
  async findImportingFiles(fileName, worktreePath) {
    const path = require('path');
    const fs = require('fs').promises;
    const importingFiles = [];
    
    try {
      // Use a simple grep-like approach to find files that import this one
      // This is a simplified implementation - could be enhanced with more sophisticated parsing
      const relativePath = path.relative(worktreePath, path.join(worktreePath, fileName));
      const baseNameWithoutExt = path.basename(fileName, path.extname(fileName));
      
      const searchPatterns = [
        `require.*['"]\\\./.*${baseNameWithoutExt}`,
        `require.*['"]\\\.\\\.*${baseNameWithoutExt}`,
        `import.*from.*['"]\\\./.*${baseNameWithoutExt}`,
        `import.*from.*['"]\\\.\\\.*${baseNameWithoutExt}`
      ];
      
      // Search through JS files in the worktree
      const jsFiles = await this.findJSFiles(worktreePath);
      
      for (const jsFile of jsFiles) { // Search all JS files for comprehensive analysis
        try {
          const content = await fs.readFile(jsFile, 'utf8');
          
          for (const pattern of searchPatterns) {
            const regex = new RegExp(pattern);
            if (regex.test(content)) {
              importingFiles.push(jsFile);
              break; // Found one match, no need to check other patterns
            }
          }
        } catch (error) {
          // Skip files that can't be read
        }
        
        if (importingFiles.length >= 3) break; // Limit to prevent excessive search
      }
      
    } catch (error) {
      logger.warn(`Error finding importing files for ${fileName}: ${error.message}`);
    }
    
    return importingFiles;
  }
  
  /**
   * Find JavaScript files in the worktree
   */
  async findJSFiles(worktreePath) {
    const path = require('path');
    const fs = require('fs').promises;
    const jsFiles = [];
    
    async function walkDir(dir, depth = 0) {
      if (depth > 3) return; // Limit depth to prevent deep recursion
      
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue; // Skip hidden files/dirs
          if (entry.name === 'node_modules') continue; // Skip node_modules
          
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            await walkDir(fullPath, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith('.js')) {
            jsFiles.push(fullPath);
          }
        }
      } catch (error) {
        // Skip directories that can't be read
      }
    }
    
    await walkDir(worktreePath);
    return jsFiles;
  }
  
  /**
   * Find configuration files relevant to the project
   */
  async findConfigFiles(worktreePath) {
    const path = require('path');
    const fs = require('fs');
    const configFiles = [];
    
    const configFileNames = [
      'package.json',
      'package-lock.json',
      '.eslintrc.js',
      '.eslintrc.json',
      '.prettierrc',
      '.prettierrc.json',
      'jest.config.js',
      'webpack.config.js',
      'babel.config.js',
      '.babelrc',
      'tsconfig.json'
    ];
    
    for (const configFileName of configFileNames) {
      const configPath = path.join(worktreePath, configFileName);
      if (fs.existsSync(configPath)) {
        configFiles.push(configPath);
      }
    }
    
    return configFiles;
  }
  
  /**
   * Build the Level 3 prompt for codebase context analysis
   */
  async buildLevel3Prompt(prId, worktreePath, changedFiles, relatedFiles) {
    const changedFilesList = changedFiles.map(f => f.file || f.fileName).join(', ');
    const relatedFilesList = relatedFiles.map(f => f.relativePath).join(', ');
    
    // Extract changed lines for each file
    let changedLinesInfo = '\n\nChanged lines by file:\n';
    for (const file of changedFiles) {
      const fileName = file.file || file.fileName;
      const changedLines = this.extractChangedLines(file);
      if (changedLines.length > 0) {
        changedLinesInfo += `- ${fileName}: lines ${changedLines.join(', ')}\n`;
      } else {
        changedLinesInfo += `- ${fileName}: all new file or unable to determine specific lines\n`;
      }
    }
    
    let relatedFilesContent = '';
    for (const relatedFile of relatedFiles) {
      relatedFilesContent += `\n\n## Related File: ${relatedFile.relativePath}\n`;
      relatedFilesContent += `Lines: ${relatedFile.lineCount}\n`;
      relatedFilesContent += '```\n';
      relatedFilesContent += relatedFile.content;
      relatedFilesContent += '\n```';
    }
    
    return `You are performing Level 3 review (Codebase Context) for pull request #${prId}.

Changed files in this PR: ${changedFilesList}
${changedLinesInfo}

Level 3 Focus - Codebase Context Analysis:
- Analyze architectural consistency across the codebase
- Identify missing tests for the changed functionality
- Find missing documentation or outdated documentation
- Look for pattern violations or inconsistencies with established patterns
- Examine cross-file dependencies and potential impact
- Check for configuration changes needed
- Identify potential breaking changes or compatibility issues

Related files discovered: ${relatedFilesList}
${relatedFilesContent}

CRITICAL REQUIREMENT: Only attach suggestions to lines that were ADDED or MODIFIED in the PR.
You MUST only use line numbers from the "Changed lines by file" list above.
If you find an issue related to unchanged code, mention it in the description but attach the suggestion to the nearest changed line in the relevant file.

IMPORTANT: Focus on codebase-wide concerns that require understanding multiple files.
Do NOT duplicate Level 1 (diff-only) or Level 2 (single-file) findings.

Output JSON with this structure:
{
  "level": 3,
  "suggestions": [{
    "file": "path/to/file",
    "line": <MUST be a line number from the changed lines list for that file>,
    "type": "bug|improvement|praise|suggestion|design|performance|security|style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why codebase context was needed",
    "suggestion": "How to fix/improve based on codebase context",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of codebase context findings"
}

Focus on architectural, testing, documentation, and cross-cutting concerns.
Remember: Only use line numbers that were actually changed in this PR.`;
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