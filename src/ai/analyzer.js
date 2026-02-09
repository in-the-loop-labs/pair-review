// SPDX-License-Identifier: GPL-3.0-or-later
const { createProvider } = require('./index');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { getGeneratedFilePatterns } = require('../git/gitattributes');
const { normalizePath, pathExistsInList, resolveRenamedFile } = require('../utils/paths');
const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('../utils/line-validation');
const { getPromptBuilder } = require('./prompts');
const { formatValidFiles } = require('./prompts/shared/valid-files');
const {
  buildAnalysisLineNumberGuidance,
  buildOrchestrationLineNumberGuidance: buildOrchestrationGuidance,
} = require('./prompts/line-number-guidance');
const { registerProcess, isAnalysisCancelled, CancellationError } = require('../routes/shared');
const { AnalysisRunRepository } = require('../database');
const { mergeInstructions } = require('../utils/instructions');
const { GitWorktreeManager } = require('../git/worktree');
const { buildSparseCheckoutGuidance } = require('./prompts/sparse-checkout-guidance');

/** Minimum total suggestion count across all voices before consolidation is applied */
const COUNCIL_CONSOLIDATION_THRESHOLD = 8;

class Analyzer {
  /**
   * @param {Object} database - Database instance
   * @param {string} model - Model to use (e.g., 'opus', 'gemini-2.5-pro')
   * @param {string} provider - Provider ID (e.g., 'claude', 'gemini'). Defaults to 'claude'.
   */
  constructor(database, model = 'opus', provider = 'claude') {
    // Store model and provider for creating provider instances per level
    this.model = model;
    this.provider = provider;
    this.db = database;
    this.testContextCache = new Map(); // Cache test detection results per worktree
    this._worktreeManager = null; // Lazy-initialized for sparse-checkout queries
  }

  /**
   * Get or create worktree manager instance (lazy initialization)
   * @returns {GitWorktreeManager}
   */
  _getWorktreeManager() {
    if (!this._worktreeManager) {
      this._worktreeManager = new GitWorktreeManager();
    }
    return this._worktreeManager;
  }

  /**
   * Perform all 3 levels of analysis in parallel
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Function} progressCallback - Callback for progress updates
   * @param {Object|string} instructions - Instructions object or legacy string for backward compatibility
   * @param {string} [instructions.repoInstructions] - Repository-level instructions from repo_settings
   * @param {string} [instructions.requestInstructions] - Request-level instructions from the analyze request
   * @param {Array<string>} changedFiles - Optional list of changed files for local mode validation
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @param {string} [options.runId] - Pre-generated run ID (required if skipRunCreation is true)
   * @param {boolean} [options.skipRunCreation] - Skip creating analysis_run record in database
   * @param {boolean} [options.skipLevel3] - Skip Level 3 codebase context analysis
   * @param {string} [options.tier='balanced'] - Analysis tier (fast, balanced, thorough)
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeAllLevels(prId, worktreePath, prMetadata, progressCallback = null, instructions = null, changedFiles = null, options = {}) {
    const runId = options.runId || uuidv4();
    const { analysisId, skipRunCreation, skipLevel3 } = options;

    if (skipRunCreation && !options.runId) {
      throw new Error('runId is required when skipRunCreation is true');
    }

    // Handle both new object format and legacy string format for backward compatibility
    let repoInstructions = null;
    let requestInstructions = null;
    let mergedInstructions = null;

    if (typeof instructions === 'string' && instructions.trim()) {
      // Legacy format: single merged instructions string (non-empty)
      mergedInstructions = instructions;
    } else if (instructions && typeof instructions === 'object') {
      // New format: object with separate instruction fields
      repoInstructions = instructions.repoInstructions || null;
      requestInstructions = instructions.requestInstructions || null;
      mergedInstructions = mergeInstructions(repoInstructions, requestInstructions);
    }

    logger.section('Multi-Level AI Analysis Starting (Parallel Execution)');
    logger.info(`PR ID: ${prId}`);
    logger.info(`Analysis run ID: ${runId}`);
    if (analysisId) {
      logger.info(`Analysis ID (for cancellation): ${analysisId}`);
    }
    logger.info(`Worktree path: ${worktreePath}`);

    // Extract head_sha from prMetadata for traceability
    // PR mode: prMetadata.head_sha is the PR head commit
    // Local mode: prMetadata.head_sha is the local HEAD commit
    const headSha = prMetadata?.head_sha || null;
    if (headSha) {
      logger.info(`HEAD SHA: ${headSha}`);
    }

    // Create analysis run record in database (skip when caller already created it)
    const analysisRunRepo = new AnalysisRunRepository(this.db);
    if (!skipRunCreation) {
      try {
        await analysisRunRepo.create({
          id: runId,
          reviewId: prId,  // prId is actually review.id (works for both PR and local modes)
          provider: this.provider,
          model: this.model,
          customInstructions: mergedInstructions,  // Keep for backward compat
          repoInstructions,
          requestInstructions,
          headSha
        });
        logger.info(`Created analysis_run record: ${runId}`);
      } catch (createError) {
        logger.warn(`Failed to create analysis_run record: ${createError.message}`);
        // Continue with analysis even if record creation fails
      }
    }

    // Load generated file patterns to skip during analysis
    const generatedPatterns = await this.loadGeneratedFilePatterns(worktreePath);
    if (generatedPatterns.length > 0) {
      logger.info(`Found ${generatedPatterns.length} generated file patterns to skip: ${generatedPatterns.join(', ')}`);
    }

    // Get changed files for validation (use provided list for local mode, or compute for PR mode)
    const validFiles = changedFiles || await this.getChangedFilesList(worktreePath, prMetadata);
    logger.info(`[Orchestration] Using ${validFiles.length} changed files for path validation`);

    // Build file line count map for line number validation
    const fileLineCountMap = await buildFileLineCountMap(worktreePath, validFiles);
    logger.info(`[Line Validation] Built line count map for ${fileLineCountMap.size} files`);

    try {
      // Note: We no longer delete old AI suggestions to preserve analysis history.
      // The API endpoint filters to show only the latest ai_run_id.

      // Run analysis levels in parallel (optionally skip level 3)
      const levelsToRun = skipLevel3 ? 2 : 3;
      logger.info(`Starting ${levelsToRun} analysis levels in parallel${skipLevel3 ? ' (Level 3 skipped)' : ''}...`);
      if (mergedInstructions) {
        logger.info(`Custom instructions provided: ${mergedInstructions.length} chars`);
      }
      const tier = options.tier || 'balanced';

      // Build the promises array - always include levels 1 and 2, optionally include level 3
      const analysisPromises = [
        this.analyzeLevel1Isolated(prId, runId, worktreePath, prMetadata, generatedPatterns, progressCallback, mergedInstructions, validFiles, { analysisId, tier }),
        this.analyzeLevel2Isolated(prId, runId, worktreePath, prMetadata, generatedPatterns, progressCallback, mergedInstructions, validFiles, { analysisId, tier })
      ];

      if (skipLevel3) {
        // Return a pre-resolved promise with skipped status (include summary for consistent result shape)
        analysisPromises.push(Promise.resolve({ suggestions: [], status: 'skipped', summary: 'Level 3 skipped' }));
        // Update progress for level 3 as skipped
        if (progressCallback) {
          progressCallback({
            status: 'skipped',
            progress: 'Skipped',
            level: 3
          });
        }
      } else {
        analysisPromises.push(
          this.analyzeLevel3Isolated(prId, runId, worktreePath, prMetadata, generatedPatterns, progressCallback, mergedInstructions, validFiles, { analysisId, tier })
        );
      }

      const results = await Promise.allSettled(analysisPromises);

      // Step 3: Collect successful results
      const levelResults = {
        level1: { suggestions: [], status: 'failed' },
        level2: { suggestions: [], status: 'failed' },
        level3: { suggestions: [], status: 'failed' }
      };

      // Check if any level was cancelled - if so, the whole analysis is cancelled
      const hasCancellation = results.some(
        r => r.status === 'rejected' && r.reason?.isCancellation
      );
      if (hasCancellation) {
        logger.info('Analysis cancelled by user');
        throw new CancellationError('Analysis cancelled by user');
      }

      results.forEach((result, index) => {
        const levelName = ['level1', 'level2', 'level3'][index];
        if (result.status === 'fulfilled') {
          // Check if this level was skipped
          if (result.value.status === 'skipped') {
            levelResults[levelName] = {
              suggestions: [],
              status: 'skipped'
            };
            logger.info(`Level ${index + 1} skipped`);
          } else {
            levelResults[levelName] = {
              suggestions: result.value.suggestions || [],
              status: 'success',
              summary: result.value.summary
            };
            logger.success(`Level ${index + 1} completed: ${levelResults[levelName].suggestions.length} suggestions`);
          }
        } else {
          // Don't log cancellation as a warning - it's expected
          if (!result.reason?.isCancellation) {
            logger.warn(`Level ${index + 1} failed: ${result.reason?.message || 'Unknown error'}`);
          }
        }
      });

      // Check if at least one level succeeded (skipped levels don't count as success, but also don't count as failure)
      const hasAnySuccess = Object.values(levelResults).some(r => r.status === 'success');
      const allNonSkippedFailed = Object.values(levelResults)
        .filter(r => r.status !== 'skipped')
        .every(r => r.status === 'failed');
      if (!hasAnySuccess && allNonSkippedFailed) {
        throw new Error('All analysis levels failed');
      }

      // Step 4: Orchestrate all suggestions
      logger.info('All levels complete. Starting orchestration...');
      if (progressCallback) {
        progressCallback({
          status: 'running',
          progress: 'Orchestrating AI suggestions for intelligent curation...',
          level: 'orchestration'
        });
      }

      try {
        const allSuggestions = {
          level1: levelResults.level1.suggestions,
          level2: levelResults.level2.suggestions,
          level3: levelResults.level3.suggestions
        };

        const orchestrationResult = await this.orchestrateWithAI(allSuggestions, prMetadata, mergedInstructions, worktreePath, { analysisId, tier, progressCallback });

        // Validate and finalize suggestions
        const finalSuggestions = this.validateAndFinalizeSuggestions(
          orchestrationResult.suggestions,
          fileLineCountMap,
          validFiles
        );

        // Store orchestrated results with ai_level = NULL (final suggestions)
        logger.info('Storing orchestrated suggestions in database...');
        await this.storeSuggestions(prId, runId, finalSuggestions, null, validFiles);

        // Update analysis_run record with completion data
        try {
          await analysisRunRepo.update(runId, {
            status: 'completed',
            summary: orchestrationResult.summary,
            totalSuggestions: finalSuggestions.length,
            filesAnalyzed: validFiles.length
          });
          logger.info(`Updated analysis_run record to completed: ${finalSuggestions.length} suggestions, ${validFiles.length} files`);
        } catch (updateError) {
          logger.warn(`Failed to update analysis_run record: ${updateError.message}`);
        }

        logger.success(`Analysis complete: ${finalSuggestions.length} final suggestions`);

        return {
          runId,
          suggestions: finalSuggestions,
          levelResults,
          summary: orchestrationResult.summary
        };

      } catch (orchestrationError) {
        logger.error(`Orchestration failed: ${orchestrationError.message}`);
        logger.warn('Falling back to storing all level suggestions without orchestration');

        // Fallback: store all suggestions as final without orchestration
        const fallbackSuggestions = [
          ...levelResults.level1.suggestions,
          ...levelResults.level2.suggestions,
          ...levelResults.level3.suggestions
        ];

        // Validate and finalize suggestions
        const finalFallbackSuggestions = this.validateAndFinalizeSuggestions(
          fallbackSuggestions,
          fileLineCountMap,
          validFiles
        );

        await this.storeSuggestions(prId, runId, finalFallbackSuggestions, null, validFiles);

        // Update analysis_run record with completion data (even though orchestration failed)
        const fallbackSummary = `Analysis complete (orchestration failed): ${finalFallbackSuggestions.length} suggestions`;
        try {
          await analysisRunRepo.update(runId, {
            status: 'completed',
            summary: fallbackSummary,
            totalSuggestions: finalFallbackSuggestions.length,
            filesAnalyzed: validFiles.length
          });
          logger.info(`Updated analysis_run record to completed (fallback): ${finalFallbackSuggestions.length} suggestions`);
        } catch (updateError) {
          logger.warn(`Failed to update analysis_run record: ${updateError.message}`);
        }

        return {
          runId,
          suggestions: finalFallbackSuggestions,
          levelResults,
          summary: fallbackSummary,
          orchestrationFailed: true
        };
      }

    } catch (error) {
      // Update analysis_run record with appropriate status
      try {
        if (error.isCancellation) {
          await analysisRunRepo.update(runId, { status: 'cancelled' });
          logger.info(`Updated analysis_run record to cancelled`);
        } else {
          await analysisRunRepo.update(runId, { status: 'failed' });
          logger.info(`Updated analysis_run record to failed`);
        }
      } catch (updateError) {
        logger.warn(`Failed to update analysis_run record on error: ${updateError.message}`);
      }

      // Don't log cancellation as an error - it's expected user behavior
      if (error.isCancellation) {
        throw error;
      }
      logger.error(`Analysis failed: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Validate and finalize suggestions by checking file paths and line numbers
   * @param {Array} suggestions - Array of suggestion objects
   * @param {Map<string, number>} fileLineCountMap - Map of file paths to line counts
   * @param {Array<string>} validFiles - List of valid file paths from the PR diff
   * @returns {Array} Finalized suggestions (valid + converted)
   */
  validateAndFinalizeSuggestions(suggestions, fileLineCountMap, validFiles) {
    const inputCount = suggestions?.length || 0;
    logger.info(`[Validation] Starting validation with ${inputCount} input suggestions`);

    // Validate suggestion file paths against PR diff
    const validatedSuggestions = this.validateSuggestionFilePaths(
      suggestions,
      validFiles
    );

    const afterPathValidation = validatedSuggestions.length;
    if (afterPathValidation < inputCount) {
      logger.info(`[Validation] After file path validation: ${afterPathValidation} suggestions (${inputCount - afterPathValidation} filtered)`);
    }

    // Line number validation with conversion to file-level
    const lineValidationResult = validateSuggestionLineNumbers(
      validatedSuggestions,
      fileLineCountMap,
      { convertToFileLevel: true }
    );

    if (lineValidationResult.converted.length > 0) {
      logger.warn(`[Line Validation] Converted ${lineValidationResult.converted.length} suggestions to file-level due to invalid line numbers`);
    }

    const finalCount = lineValidationResult.valid.length + lineValidationResult.converted.length;
    logger.info(`[Validation] Final: ${finalCount} suggestions (${lineValidationResult.valid.length} valid, ${lineValidationResult.converted.length} converted)`);

    // Debug: If all suggestions were filtered out, log details
    if (finalCount === 0 && inputCount > 0) {
      logger.warn(`[Validation] WARNING: All ${inputCount} suggestions were filtered out!`);
      logger.warn(`[Validation] File path filtering removed: ${inputCount - afterPathValidation}`);
      // Note: With convertToFileLevel=true, invalid line numbers are converted (not dropped)
      // Log both converted and dropped counts for clarity
      const droppedCount = lineValidationResult.dropped?.length || 0;
      const convertedCount = lineValidationResult.converted?.length || 0;
      if (droppedCount > 0) {
        logger.warn(`[Validation] Line validation dropped: ${droppedCount}`);
      }
      if (convertedCount > 0) {
        logger.warn(`[Validation] Line validation converted to file-level: ${convertedCount}`);
      }
    }

    // Return valid + converted suggestions
    return [...lineValidationResult.valid, ...lineValidationResult.converted];
  }

  /**
   * Load generated file patterns from .gitattributes
   * @param {string} worktreePath - Path to the git worktree
   * @returns {Promise<Array<string>>} Array of generated file patterns
   */
  async loadGeneratedFilePatterns(worktreePath) {
    try {
      const parser = await getGeneratedFilePatterns(worktreePath);
      return parser.getPatterns();
    } catch (error) {
      logger.warn(`Could not load generated file patterns: ${error.message}`);
      return [];
    }
  }

  /**
   * Get the absolute path to the git-diff-lines script
   * @returns {string} Absolute path to bin/git-diff-lines
   */
  getAnnotatedDiffScriptPath() {
    return path.resolve(__dirname, '../../bin/git-diff-lines');
  }

  /**
   * Build the line number guidance section for prompts
   * @param {string} worktreePath - Path to the git worktree (used to ensure git runs in correct directory)
   * @returns {string} Markdown guidance for line numbers
   */
  buildLineNumberGuidance(worktreePath = null) {
    return buildAnalysisLineNumberGuidance({
      scriptCommand: this._buildScriptCommand(worktreePath),
    });
  }

  /**
   * Build lightweight line number guidance for the orchestration step.
   *
   * Unlike buildLineNumberGuidance() (used for levels 1-3), this does NOT
   * instruct the AI to routinely run git-diff-lines or verify every line number.
   * The orchestration step receives pre-computed suggestions whose line numbers
   * were already determined by the analysis levels; its primary job is to
   * intelligently combine them. However, it retains access to git-diff-lines
   * for cases where it needs to investigate conflicting suggestions or verify
   * a specific concern.
   *
   * @param {string|null} worktreePath - Path to the git worktree (for --cwd option)
   * @returns {string} Orchestration-specific line number guidance
   */
  buildOrchestrationLineNumberGuidance(worktreePath = null) {
    return buildOrchestrationGuidance({
      scriptCommand: this._buildScriptCommand(worktreePath),
    });
  }

  /**
   * Build the full script command string, optionally including --cwd.
   *
   * Uses the bare command name since BIN_DIR is added to PATH in all
   * providers.  Using the absolute path causes issues with AI providers
   * that pattern-match allowed tools (e.g., Gemini only matches
   * 'git-diff-lines', not the full path).
   *
   * @param {string|null} worktreePath - Path to the git worktree
   * @returns {string} e.g. `git-diff-lines` or `git-diff-lines --cwd "/path"`
   * @private
   */
  _buildScriptCommand(worktreePath) {
    const scriptCommand = 'git-diff-lines';
    const cwdOption = worktreePath ? ` --cwd "${worktreePath}"` : '';
    return `${scriptCommand}${cwdOption}`;
  }

  /**
   * Build sparse-checkout guidance if applicable
   * @param {string} worktreePath - Path to the worktree
   * @returns {Promise<string>} Guidance text or empty string
   */
  async buildSparseCheckoutGuidanceSection(worktreePath) {
    const worktreeManager = this._getWorktreeManager();
    const isEnabled = await worktreeManager.isSparseCheckoutEnabled(worktreePath);

    if (!isEnabled) {
      return '';
    }

    const patterns = await worktreeManager.getSparseCheckoutPatterns(worktreePath);
    return buildSparseCheckoutGuidance({ patterns });
  }

  /**
   * Build the section of the prompt that includes custom review instructions
   * @param {string} customInstructions - Custom instructions text
   * @returns {string} Prompt section or empty string
   */
  buildCustomInstructionsSection(customInstructions) {
    if (!customInstructions || customInstructions.trim().length === 0) {
      return '';
    }

    return `## Additional Review Instructions
The following custom instructions have been provided for this review. Please incorporate these guidelines into your analysis:

${customInstructions.trim()}
`;
  }

  /**
   * Build the section of the prompt that lists valid files for suggestions
   * @param {Array<string>} changedFiles - List of changed file paths
   * @returns {string} Prompt section or empty string
   */
  buildChangedFilesSection(changedFiles) {
    if (!changedFiles || changedFiles.length === 0) {
      return '';
    }

    return `
## Valid Files for Suggestions
You should ONLY create suggestions for files in this list:
${changedFiles.map(f => `- ${f}`).join('\n')}

Do NOT create suggestions for any files not in this list. If you cannot find issues in these files, that's okay - just return fewer suggestions.
`;
  }

  /**
   * Get list of changed files from git diff
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base/head SHAs
   * @returns {Promise<Array<string>>} List of changed file paths
   */
  async getChangedFilesList(worktreePath, prMetadata) {
    try {
      const { stdout } = await execPromise(
        `git diff ${prMetadata.base_sha}...${prMetadata.head_sha} --name-only`,
        { cwd: worktreePath }
      );
      return stdout.trim().split('\n').filter(f => f.length > 0);
    } catch (error) {
      logger.warn(`Could not get changed files list: ${error.message}`);
      return [];
    }
  }

  /**
   * Get list of changed files for local mode analysis
   * Includes unstaged changes and untracked files only.
   *
   * Design note: Staged files are intentionally excluded. Local mode focuses on
   * reviewing uncommitted working directory changes before they are staged.
   * Staged changes are considered "ready to commit" and outside the scope of
   * local review at this point.
   *
   * @param {string} localPath - Path to the local git repository
   * @returns {Promise<Array<string>>} List of changed file paths
   */
  async getLocalChangedFiles(localPath) {
    try {
      // Get modified tracked files (unstaged only - staged files are excluded by design)
      const { stdout: unstaged } = await execPromise(
        'git diff --name-only',
        { cwd: localPath }
      );

      // Get untracked files
      const { stdout: untracked } = await execPromise(
        'git ls-files --others --exclude-standard',
        { cwd: localPath }
      );

      // Combine and dedupe (no staged files - see design note above)
      // Filter empty strings immediately after split to handle empty git output
      const unstagedFiles = unstaged.trim().split('\n').filter(f => f.length > 0);
      const untrackedFiles = untracked.trim().split('\n').filter(f => f.length > 0);
      const allFiles = [...unstagedFiles, ...untrackedFiles];

      return [...new Set(allFiles)];
    } catch (error) {
      logger.warn(`Could not get local changed files for ${localPath}: ${error.message}`);
      return [];
    }
  }

  /**
   * Validate suggestion file paths against the PR diff
   * Filters out suggestions that reference files not in the PR diff
   *
   * @param {Array} suggestions - Array of suggestions to validate
   * @param {Array<string>} validPaths - List of valid file paths from the PR diff
   * @returns {Array} Filtered suggestions with only valid file paths
   */
  validateSuggestionFilePaths(suggestions, validPaths) {
    if (!suggestions || suggestions.length === 0) {
      return [];
    }

    if (!validPaths || validPaths.length === 0) {
      logger.warn('[Orchestration] No valid paths provided for validation, skipping path filtering');
      return suggestions;
    }

    // Create a Set of normalized valid paths for efficient lookup
    // Resolve git rename syntax (e.g., "tests/{old.js => new.js}" → "tests/new.js")
    // so both the rename syntax path and the plain new filename will match
    const normalizedValidPaths = new Set(validPaths.map(p => normalizePath(resolveRenamedFile(p))));

    const validSuggestions = [];
    const discardedSuggestions = [];

    for (const suggestion of suggestions) {
      const normalizedSuggestionPath = normalizePath(resolveRenamedFile(suggestion.file));

      if (normalizedValidPaths.has(normalizedSuggestionPath)) {
        validSuggestions.push(suggestion);
      } else {
        discardedSuggestions.push({
          file: suggestion.file,
          normalizedPath: normalizedSuggestionPath,
          title: suggestion.title,
          type: suggestion.type
        });
      }
    }

    // Log discarded suggestions for debugging
    if (discardedSuggestions.length > 0) {
      logger.warn(`[Orchestration] Discarded ${discardedSuggestions.length} suggestion(s) with invalid file paths:`);
      for (const discarded of discardedSuggestions) {
        logger.warn(`  - "${discarded.file}" (normalized: "${discarded.normalizedPath}"): ${discarded.type} - ${discarded.title}`);
      }
      logger.info(`[Orchestration] Valid paths in PR diff: ${Array.from(normalizedValidPaths).slice(0, 10).join(', ')}${normalizedValidPaths.size > 10 ? '...' : ''}`);
    }

    return validSuggestions;
  }

  /**
   * Build the section of the prompt that instructs to skip generated files
   * @param {Array<string>} generatedPatterns - Patterns of generated files
   * @returns {string} Prompt section or empty string
   */
  buildGeneratedFilesExclusionSection(generatedPatterns) {
    if (!generatedPatterns || generatedPatterns.length === 0) {
      return '';
    }

    return `
## Generated Files - DO NOT ANALYZE
The following files are marked as generated in .gitattributes and should be SKIPPED entirely:
${generatedPatterns.map(p => `- ${p}`).join('\n')}

These are auto-generated files (like package-lock.json, build outputs, etc.) that should not be reviewed.
When running git diff, you can exclude these with: git diff ${'{base}'}...${'{head}'} -- ':!pattern' for each pattern.
Or simply ignore any changes to files matching these patterns in your analysis.
`;
  }

  /**
   * Perform Level 1 analysis on a PR (backwards compatibility wrapper)
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Function} progressCallback - Callback for progress updates
   * @param {Object|string} instructions - Instructions object or legacy string for backward compatibility
   * @param {string} [instructions.repoInstructions] - Repository-level instructions from repo_settings
   * @param {string} [instructions.requestInstructions] - Request-level instructions from the analyze request
   * @param {Array<string>} changedFiles - Optional list of changed files for local mode validation
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel1(prId, worktreePath, prMetadata, progressCallback = null, instructions = null, changedFiles = null, options = {}) {
    // This is now a wrapper that calls the parallel implementation
    return this.analyzeAllLevels(prId, worktreePath, prMetadata, progressCallback, instructions, changedFiles, options);
  }

  /**
   * Isolated Level 1 analysis (no auto-chaining)
   * @param {number} prId - Pull request ID
   * @param {string} runId - Analysis run ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} generatedPatterns - Patterns of generated files to skip
   * @param {Function} progressCallback - Callback for progress updates
   * @param {string} customInstructions - Optional custom instructions to include in prompts
   * @param {Array<string>} changedFiles - Optional list of changed files for local mode validation
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel1Isolated(prId, runId, worktreePath, prMetadata, generatedPatterns = [], progressCallback = null, customInstructions = null, changedFiles = null, options = {}) {
    const { analysisId, tier = 'balanced' } = options;
    logger.info('[Level 1] Analysis Starting');

    try {
      // Check if analysis was cancelled before starting
      if (analysisId && isAnalysisCancelled(analysisId)) {
        throw new CancellationError('Analysis was cancelled');
      }

      // Create provider instance for this level
      const aiProvider = createProvider(this.provider, this.model);

      const updateProgress = (step) => {
        const progress = `[Level 1] ${step}...`;

        if (progressCallback) {
          progressCallback({
            status: 'running',
            progress,
            level: 1
          });
        }
        logger.info(progress);
      };

      // Build the Level 1 prompt
      updateProgress('Building prompt for AI to analyze changes');
      const prompt = this.buildLevel1Prompt(prId, worktreePath, prMetadata, generatedPatterns, customInstructions, changedFiles || [], tier);

      // Execute Claude CLI in the worktree directory
      updateProgress('Running AI to analyze changes in isolation');
      const response = await aiProvider.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000, // 10 minutes for Level 1
        level: 1,
        analysisId,
        registerProcess,
        onStreamEvent: progressCallback ? (event) => {
          progressCallback({ level: 1, status: 'running', streamEvent: event });
        } : undefined
      });

      // Parse and validate the response
      updateProgress('Processing AI results');
      const parsedSuggestions = this.parseResponse(response, 1);
      logger.success(`Parsed ${parsedSuggestions.length} valid Level 1 suggestions`);

      // Validate suggestion file paths if changedFiles provided
      const suggestions = (changedFiles && changedFiles.length > 0)
        ? this.validateSuggestionFilePaths(parsedSuggestions, changedFiles)
        : parsedSuggestions;
      if (changedFiles && changedFiles.length > 0) {
        logger.success(`After path validation: ${suggestions.length} suggestions`);
      }

      // Store Level 1 suggestions
      updateProgress('Storing Level 1 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 1, changedFiles);
      logger.success(`Level 1 complete: ${suggestions.length} suggestions`);

      // Report completion to progress callback
      if (progressCallback) {
        progressCallback({
          status: 'completed',
          progress: `Level 1 complete: ${suggestions.length} suggestions`,
          level: 1
        });
      }

      return {
        suggestions,
        summary: response.summary || `[Level 1] Found ${suggestions.length} suggestions`
      };

    } catch (error) {
      // Don't log cancellation as an error - it's expected user behavior
      if (!error.isCancellation) {
        logger.error(`Level 1 analysis failed: ${error.message}`);
      }

      // Report failure to progress callback (unless cancelled)
      if (progressCallback && !error.isCancellation) {
        progressCallback({
          status: 'failed',
          progress: `Level 1 failed: ${error.message}`,
          level: 1
        });
      }

      throw error;
    }
  }

  /**
   * Build the review introduction line for prompts
   * Adapts terminology based on whether this is a PR review or local review
   * @param {number} reviewId - Review/PR ID
   * @param {Object} prMetadata - PR/review metadata
   * @returns {string} Introduction line for the prompt
   */
  buildReviewIntroduction(reviewId, prMetadata) {
    const isLocal = prMetadata.reviewType === 'local';
    if (isLocal) {
      return `You are reviewing local changes (review #${reviewId}) in the current working directory.`;
    }
    return `You are reviewing pull request #${reviewId} in the current working directory.`;
  }

  /**
   * Build context section for inclusion in analysis prompts
   * Adapts terminology based on whether this is a PR review or local review
   * @param {Object} prMetadata - PR/review metadata with title and description
   * @param {string} criticalNote - Level-specific critical note text
   * @returns {string} Context section or empty string
   */
  buildPRContextSection(prMetadata, criticalNote) {
    // Check for null/undefined explicitly to include section even if fields are empty strings
    if (prMetadata.title != null || prMetadata.description != null) {
      const isLocal = prMetadata.reviewType === 'local';
      const sectionTitle = isLocal ? 'Review Context' : 'Pull Request Context';
      const descriptionLabel = isLocal ? 'Description:' : "Author's Description:";

      // Build metadata lines (repository for both modes, PR-specific fields only for PR mode)
      const lines = [];
      if (prMetadata.repository) {
        lines.push(`**Repository:** ${prMetadata.repository}`);
      }
      if (!isLocal) {
        if (prMetadata.pr_number) {
          lines.push(`**PR #:** ${prMetadata.pr_number}`);
        }
        if (prMetadata.author) {
          lines.push(`**Author:** @${prMetadata.author}`);
        }
      }
      const metadataLines = lines.length > 0 ? lines.join('\n') + '\n' : '';

      return `
## ${sectionTitle}
${metadataLines}**Title:** ${prMetadata.title || '(No title provided)'}

**${descriptionLabel}**
${prMetadata.description || '(No description provided)'}

⚠️ **Critical Note:** ${criticalNote}

`;
    }
    return '';
  }

  /**
   * Build the appropriate git diff command based on review type
   * For PR reviews: git diff base_sha...head_sha
   * For local reviews: git diff HEAD (all uncommitted changes - both staged and unstaged)
   * @param {Object} prMetadata - PR/review metadata
   * @param {string} suffix - Optional suffix like '<file>' or '--name-only'
   * @returns {string} The git diff command
   */
  buildGitDiffCommand(prMetadata, suffix = '') {
    const isLocal = prMetadata.reviewType === 'local';
    if (isLocal) {
      // For local mode, diff against HEAD to see working directory changes
      return suffix ? `git diff HEAD ${suffix}` : 'git diff HEAD';
    }
    // For PR mode, diff between base and head commits
    const baseCmd = `git diff ${prMetadata.base_sha}...${prMetadata.head_sha}`;
    return suffix ? `${baseCmd} ${suffix}` : baseCmd;
  }

  /**
   * Build the Level 2 prompt for file context analysis
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array<string>} generatedPatterns - Patterns for generated files to skip
   * @param {string} customInstructions - Optional custom instructions to include in prompt
   * @param {Array<string>} changedFiles - List of changed file paths for grounding
   * @param {string} tier - Capability tier: 'fast', 'balanced', or 'thorough' (default: 'balanced')
   */
  buildLevel2Prompt(prId, worktreePath, prMetadata, generatedPatterns = [], customInstructions = null, changedFiles = [], tier = 'balanced') {
    logger.debug(`[Level 2] Building prompt with tier: ${tier}`);
    // Try new prompt architecture first
    const promptBuilder = getPromptBuilder('level2', tier, this.provider);

    if (promptBuilder) {
      // Build context for the new tagged prompt system
      const criticalNote = `Treat this description as the author's CLAIM about what they changed and why. As you analyze file-level consistency, verify if the actual changes align with this description. Be alert for:
- Significant functionality changes not mentioned in the description
- Inconsistencies between stated goals and implementation patterns
- Scope creep beyond what was described`;

      const context = {
        reviewIntro: this.buildReviewIntroduction(prId, prMetadata),
        prContext: this.buildPRContextSection(prMetadata, criticalNote),
        customInstructions: this.buildCustomInstructionsSection(customInstructions),
        lineNumberGuidance: this.buildLineNumberGuidance(worktreePath),
        generatedFiles: this.buildGeneratedFilesExclusionSection(generatedPatterns),
        validFiles: formatValidFiles(changedFiles)
      };

      logger.debug('[Level 2] Using new prompt architecture');
      return promptBuilder.build(context);
    }

    // Fallback to legacy implementation if prompt not migrated
    logger.debug('[Level 2] Using legacy prompt implementation');
    return this._buildLevel2PromptLegacy(prId, worktreePath, prMetadata, generatedPatterns, customInstructions, changedFiles);
  }

  /**
   * Legacy Level 2 prompt builder (fallback)
   * @private
   */
  _buildLevel2PromptLegacy(prId, worktreePath, prMetadata, generatedPatterns = [], customInstructions = null, changedFiles = []) {
    const prContext = this.buildPRContextSection(prMetadata,
      `Treat this description as the author's CLAIM about what they changed and why. As you analyze file-level consistency, verify if the actual changes align with this description. Be alert for:
- Significant functionality changes not mentioned in the description
- Inconsistencies between stated goals and implementation patterns
- Scope creep beyond what was described`);

    const generatedFilesSection = this.buildGeneratedFilesExclusionSection(generatedPatterns);
    const customInstructionsSection = this.buildCustomInstructionsSection(customInstructions);
    const changedFilesSection = this.buildChangedFilesSection(changedFiles);
    const lineNumberGuidance = this.buildLineNumberGuidance(worktreePath);

    return `${this.buildReviewIntroduction(prId, prMetadata)}
${prContext}${customInstructionsSection}# Level 2 Review - Analyze File Context
${lineNumberGuidance}
${generatedFilesSection}${changedFilesSection}
## Analysis Process
For each file with changes:
   - Read the full file content to understand context
   - Run the annotated diff tool (shown above) with the file path to see what changed with line numbers
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

## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- The annotated diff tool shown above with file path (preferred for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- grep, find, ls commands as needed

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to examine multiple files simultaneously if that would be helpful.

## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
{
  "level": 2,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve based on file context (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation (architecture, organization, naming, etc.)",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of file context findings"
}

## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number. This is correct for:
  - ADDED lines marked with [+]
  - CONTEXT lines (unchanged lines that appear in both versions)
- **"OLD"**: Use the OLD column number. ONLY use this for DELETED lines marked with [-].

**IMPORTANT**: Context lines exist in BOTH the old and new file - always use "NEW" for context lines.
Only use "OLD" when the line is prefixed with [-] indicating it was deleted.

If you are unsure, use "NEW" - it is correct for the vast majority of suggestions.

## File-Level Suggestions
In addition to line-specific suggestions, you may include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines, such as:
- Overall file architecture or organization issues
- Naming convention concerns for the file/module
- Missing tests for the file
- File structure improvements
- Module-level design patterns
- Overall code organization within the file

File-level suggestions should NOT have a line number. They apply to the entire file.

## Important Guidelines
- You may attach line-specific suggestions to any line within modified files, including context lines when they reveal file-level issues.
- Focus on issues that require understanding the full file context
- Focus on file-level patterns and consistency
- For "praise" type: Omit the suggestion field entirely to save tokens
- For other types: Include specific, actionable suggestions`;
  }


  /**
   * Build the Level 1 prompt
   * @param {number} prId - Pull request ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array<string>} generatedPatterns - Patterns for generated files to skip
   * @param {string} customInstructions - Optional custom instructions to include in prompt
   * @param {Array<string>} changedFiles - List of changed file paths for grounding
   * @param {string} tier - Capability tier: 'fast', 'balanced', or 'thorough' (default: 'balanced')
   */
  buildLevel1Prompt(prId, worktreePath, prMetadata, generatedPatterns = [], customInstructions = null, changedFiles = [], tier = 'balanced') {
    logger.debug(`[Level 1] Building prompt with tier: ${tier}`);
    // Try new prompt architecture first
    const promptBuilder = getPromptBuilder('level1', tier, this.provider);

    if (promptBuilder) {
      // Build context for the new tagged prompt system
      const criticalNote = `Treat this description as the author's CLAIM about what they changed and why. Your job is to independently verify if the actual code changes align with this description. As you analyze, be alert for:
- Discrepancies between the description and actual implementation
- Undocumented changes or side effects not mentioned in the description
- Overstated or understated scope`;

      // Note: Level 1 uses "validFiles" key to match the {{validFiles}} placeholder in Level 1 prompts.
      // Level 3 uses "changedFiles" key for its {{changedFiles}} placeholder. Same underlying data,
      // different naming to reflect semantic intent: L1/L2 emphasize "valid files for suggestions"
      // (constraint perspective), while L3 emphasizes "changed files in this PR" (context perspective).
      const context = {
        reviewIntro: this.buildReviewIntroduction(prId, prMetadata),
        prContext: this.buildPRContextSection(prMetadata, criticalNote),
        customInstructions: this.buildCustomInstructionsSection(customInstructions),
        lineNumberGuidance: this.buildLineNumberGuidance(worktreePath),
        generatedFiles: this.buildGeneratedFilesExclusionSection(generatedPatterns),
        validFiles: formatValidFiles(changedFiles)
      };

      logger.debug('[Level 1] Using new prompt architecture');
      return promptBuilder.build(context);
    }

    // Fallback to legacy implementation if prompt not migrated
    logger.debug('[Level 1] Using legacy prompt implementation');
    const prContext = this.buildPRContextSection(prMetadata,
      `Treat this description as the author's CLAIM about what they changed and why. Your job is to independently verify if the actual code changes align with this description. As you analyze, be alert for:
- Discrepancies between the description and actual implementation
- Undocumented changes or side effects not mentioned in the description
- Overstated or understated scope`);

    const generatedFilesSection = this.buildGeneratedFilesExclusionSection(generatedPatterns);
    const customInstructionsSection = this.buildCustomInstructionsSection(customInstructions);
    const lineNumberGuidance = this.buildLineNumberGuidance(worktreePath);

    return `${this.buildReviewIntroduction(prId, prMetadata)}
${prContext}${customInstructionsSection}# Level 1 Review - Analyze Changes in Isolation
${lineNumberGuidance}
## Speed and Scope Expectations
**This level should be fast** - focusing only on the diff itself without exploring file context or surrounding unchanged code. That analysis is reserved for Level 2.
${generatedFilesSection}
## Initial Setup
1. Run the annotated diff tool (shown above) to see the changes with line numbers
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

## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- The annotated diff tool shown above (preferred for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- ls, find, grep commands as needed

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to analyze different parts of the changes if that would be helpful.

## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve (omit this field for praise items - no action needed)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
}

## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number. This is correct for:
  - ADDED lines marked with [+]
  - CONTEXT lines (unchanged lines that appear in both versions)
- **"OLD"**: Use the OLD column number. ONLY use this for DELETED lines marked with [-].

**IMPORTANT**: Context lines exist in BOTH the old and new file - always use "NEW" for context lines.
Only use "OLD" when the line is prefixed with [-] indicating it was deleted.

If you are unsure, use "NEW" - it is correct for the vast majority of suggestions.

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
- You may comment on any line in modified files. Prioritize changed lines, but include unchanged lines when they reveal issues (missing error handling, inconsistent patterns, etc.)
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
    const levelPrefix = `[Level ${level}]`;

    // Separate previous suggestions into line-level and file-level for deduplication
    const previousLineSuggestions = previousSuggestions.filter(s => !s.is_file_level);
    const previousFileLevelSuggestions = previousSuggestions.filter(s => s.is_file_level);

    // If response is already parsed JSON
    if (response.suggestions && Array.isArray(response.suggestions)) {
      const lineSuggestions = this.validateSuggestions(response.suggestions, previousLineSuggestions);
      const fileLevelSuggestions = response.fileLevelSuggestions
        ? this.validateFileLevelSuggestions(response.fileLevelSuggestions, previousFileLevelSuggestions)
        : [];
      return [...lineSuggestions, ...fileLevelSuggestions];
    }

    // If response is raw text, try multiple extraction strategies
    if (response.raw) {
      const extracted = extractJSON(response.raw, level);
      if (extracted.success && extracted.data.suggestions && Array.isArray(extracted.data.suggestions)) {
        const lineSuggestions = this.validateSuggestions(extracted.data.suggestions, previousLineSuggestions);
        const fileLevelSuggestions = extracted.data.fileLevelSuggestions
          ? this.validateFileLevelSuggestions(extracted.data.fileLevelSuggestions, previousFileLevelSuggestions)
          : [];
        return [...lineSuggestions, ...fileLevelSuggestions];
      } else {
        logger.warn(`${levelPrefix} JSON extraction failed: ${extracted.error}`);
        logger.info(`${levelPrefix} Raw response length: ${response.raw.length} characters`);
        logger.info(`${levelPrefix} Raw response preview: ${response.raw.substring(0, 500)}...`);
      }
    }

    // Fallback to empty array
    logger.warn(`${levelPrefix} No valid suggestions found in response`);
    return [];
  }

  /**
   * Validate and filter file-level suggestions (suggestions about entire files, not tied to specific lines)
   * @param {Array} suggestions - Raw file-level suggestions from AI
   * @param {Array} previousFileLevelSuggestions - Previous file-level suggestions to check for duplicates
   * @returns {Array} Validated file-level suggestions
   */
  validateFileLevelSuggestions(suggestions, previousFileLevelSuggestions = []) {
    if (!suggestions || !Array.isArray(suggestions)) {
      return [];
    }

    const validSuggestions = suggestions
      .map(s => {
        // Normalize: If title is missing but description exists, extract first line as title
        if (!s.title && s.description) {
          const firstLine = s.description.split(/[.\n]/)[0].trim();
          const title = firstLine.length > 150
            ? firstLine.substring(0, 147) + '...'
            : firstLine;

          return {
            ...s,
            title: title,
            description: s.description
          };
        }
        return s;
      })
      .filter(s => {
        // File-level suggestions require file, type, and title but NOT line
        if (!s.file || !s.type || !s.title) {
          logger.warn(`Skipping invalid file-level suggestion: ${JSON.stringify(s)}`);
          return false;
        }

        // Filter out suggestions with missing, zero, or low confidence
        // Missing/zero confidence indicates low quality and should be discarded
        if (!s.confidence || s.confidence <= 0 || s.confidence < 0.3) {
          logger.info(`Filtering low/missing confidence file-level suggestion: ${s.title} (${s.confidence || 'missing'})`);
          return false;
        }

        return true;
      })
      .map(s => ({
        file: s.file,
        line_start: null,  // File-level suggestions have no line numbers
        line_end: null,
        old_or_new: null,  // Not applicable for file-level suggestions
        type: s.type,
        title: s.title,
        description: s.description || '',
        suggestion: s.suggestion || '',
        confidence: s.confidence || 0.7,
        is_file_level: true  // Mark as file-level suggestion
      }));

    // Deduplicate against previous file-level suggestions
    return this.deduplicateFileLevelSuggestions(validSuggestions, previousFileLevelSuggestions);
  }

  /**
   * Deduplicate file-level suggestions against previous file-level suggestions
   * @param {Array} newSuggestions - New file-level suggestions to check
   * @param {Array} previousSuggestions - Previous file-level suggestions to compare against
   * @returns {Array} Filtered suggestions with duplicates removed
   */
  deduplicateFileLevelSuggestions(newSuggestions, previousSuggestions) {
    if (!previousSuggestions || previousSuggestions.length === 0) {
      return newSuggestions;
    }

    return newSuggestions.filter(newSugg => {
      // Check for duplicates based on file, type, and body/description similarity
      const hasSimilarMatch = previousSuggestions.some(prevSugg => {
        // Must be same file and type
        if (prevSugg.file !== newSugg.file || prevSugg.type !== newSugg.type) {
          return false;
        }

        // Check text similarity for deduplication
        const newText = (newSugg.title || '') + ' ' + (newSugg.description || '');
        const prevText = (prevSugg.title || '') + ' ' + (prevSugg.description || '');
        const similarity = this.calculateTextSimilarity(newText, prevText);

        return similarity > 0.8; // 80% similarity threshold
      });

      if (hasSimilarMatch) {
        logger.info(`Filtering duplicate file-level suggestion: ${newSugg.title} (${newSugg.file})`);
        return false;
      }

      return true;
    });
  }

  /**
   * Validate and filter suggestions
   * @param {Array} suggestions - Raw suggestions from AI
   * @param {Array} previousSuggestions - Previous suggestions to check for duplicates
   */
  validateSuggestions(suggestions, previousSuggestions = []) {
    const validSuggestions = suggestions
      .map(s => {
        // Normalize: Convert old 'line' format to 'line_start'/'line_end' format
        // Some AI models may still output 'line' despite schema requesting line_start/line_end
        if (s.line !== undefined && s.line_start === undefined) {
          s.line_start = s.line;
          s.line_end = s.line_end || s.line;
          delete s.line;
        }

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
        if (!s.file || !s.line_start || !s.type || !s.title) {
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
        line_start: s.line_start,
        line_end: s.line_end ?? s.line_start,
        old_or_new: s.old_or_new || 'NEW',  // Default to NEW for added/context lines
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
        prevSugg.line_start === newSugg.line_start &&
        prevSugg.type === newSugg.type
      );

      if (hasExactMatch) {
        // Check text similarity for final deduplication
        const hasSimilarText = previousSuggestions.some(prevSugg => {
          if (prevSugg.file === newSugg.file &&
              prevSugg.line_start === newSugg.line_start &&
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
          logger.info(`Filtering duplicate suggestion: ${newSugg.title} (${newSugg.file}:${newSugg.line_start})`);
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
   * Includes failsafe filter to reject suggestions with invalid file paths
   * @param {number} reviewId - Review ID (from reviews table, works for both PR and local modes)
   * @param {string} runId - Analysis run ID
   * @param {Array} suggestions - Suggestions to store
   * @param {number|string} level - Analysis level
   * @param {Array<string>} changedFiles - Optional list of changed files for local mode fallback
   */
  async storeSuggestions(reviewId, runId, suggestions, level, changedFiles = null) {
    const { run } = require('../database');

    // FAILSAFE: Get valid file paths to filter suggestions against
    // Prefer changedFiles parameter when available for performance (avoids DB lookup)
    // Fallback to getValidFilePaths() which properly looks up pr_metadata via review.id
    let validFilePaths;
    if (changedFiles && changedFiles.length > 0) {
      validFilePaths = changedFiles.map(f => normalizePath(resolveRenamedFile(f)));
    } else {
      // Fallback to pr_metadata lookup via review -> pr_metadata join
      validFilePaths = await this.getValidFilePaths(reviewId);
    }

    // Create a Set of normalized valid paths for O(1) lookup
    const validPathsSet = new Set(validFilePaths);

    // Filter suggestions to only those with valid file paths
    const validSuggestions = [];
    let filteredCount = 0;

    for (const suggestion of suggestions) {
      // Check if the suggestion's file path exists in the PR diff
      if (!this.isValidSuggestionPath(suggestion.file, validPathsSet)) {
        filteredCount++;
        logger.warn(
          `[FAILSAFE] Filtered AI suggestion with invalid path: "${suggestion.file}" ` +
          `(expected one of: ${validFilePaths.slice(0, 5).join(', ')}${validFilePaths.length > 5 ? '...' : ''})`
        );
        continue;
      }
      validSuggestions.push(suggestion);
    }

    if (filteredCount > 0) {
      logger.warn(`[FAILSAFE] Filtered ${filteredCount} suggestions with invalid file paths`);
    }

    // Store only valid suggestions
    for (const suggestion of validSuggestions) {
      const body = suggestion.description +
        (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');

      // Handle different level types including orchestrated
      const aiLevel = typeof level === 'string' ? level : level;

      // Determine if this is a file-level suggestion
      // File-level suggestions have is_file_level=true or have null line_start
      const isFileLevel = suggestion.is_file_level === true || suggestion.line_start === null ? 1 : 0;

      // Map old_or_new to database side column: OLD -> LEFT, NEW -> RIGHT
      // File-level suggestions (null old_or_new) default to RIGHT
      const side = suggestion.old_or_new === 'OLD' ? 'LEFT' : 'RIGHT';

      // Log overall suggestions at debug level (level === null means orchestrated/final suggestions)
      // Short-circuit: check debug flag first to avoid string construction when disabled
      if (level === null && logger.isDebugEnabled()) {
        const lineInfo = suggestion.line_start !== null ? `L${suggestion.line_start}` : 'file-level';
        logger.debug(`[Suggestion] ${suggestion.file}:${lineInfo} (${side}) - ${suggestion.title || '(no title)'}`);
      }

      await run(this.db, `
        INSERT INTO comments (
          review_id, source, author, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, side, type, title, body, status, is_file_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        reviewId,
        'ai',
        'AI Assistant',
        runId,
        aiLevel,
        suggestion.confidence,
        suggestion.file,
        suggestion.line_start,
        suggestion.line_end,
        side,
        suggestion.type,
        suggestion.title,
        body,
        'active',
        isFileLevel
      ]);
    }

    logger.success(`Stored ${validSuggestions.length} suggestions in database`);
  }

  /**
   * Get valid file paths from PR metadata
   * @param {number} reviewId - Review ID (from reviews table, NOT pr_metadata.id)
   * @returns {Promise<Array<string>>} Array of valid file paths from the PR diff
   */
  async getValidFilePaths(reviewId) {
    const { queryOne } = require('../database');

    try {
      // First, look up the review to get pr_number and repository
      // reviewId is from the reviews table, not pr_metadata.id
      const review = await queryOne(this.db, `
        SELECT pr_number, repository, review_type FROM reviews WHERE id = ?
      `, [reviewId]);

      if (!review) {
        logger.warn(`[FAILSAFE] Review not found for reviewId=${reviewId}`);
        return [];
      }

      // For local mode reviews, there is no pr_metadata - return empty
      if (review.review_type === 'local' || !review.pr_number) {
        // This is expected for local mode - not a warning condition
        return [];
      }

      // Now look up pr_metadata using the natural key (pr_number + repository)
      const prMetadata = await queryOne(this.db, `
        SELECT pr_data FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE
      `, [review.pr_number, review.repository]);

      if (!prMetadata || !prMetadata.pr_data) {
        logger.warn(`[FAILSAFE] PR metadata not found for PR #${review.pr_number} in ${review.repository}`);
        return [];
      }

      const prData = JSON.parse(prMetadata.pr_data);
      const changedFiles = prData.changed_files || [];

      // Extract file paths and normalize them
      return changedFiles.map(f => {
        // changed_files entries can be objects with 'file' property or just strings
        const filePath = typeof f === 'string' ? f : (f.file || '');
        return normalizePath(filePath);
      }).filter(p => p.length > 0);

    } catch (error) {
      logger.error(`[FAILSAFE] Error getting valid file paths: ${error.message}`);
      return [];
    }
  }

  /**
   * Check if a suggestion's file path is valid (exists in PR diff)
   * @param {string} suggestionPath - The file path from the suggestion
   * @param {Array<string>|Set<string>} validPaths - Array or Set of valid (normalized) file paths
   * @returns {boolean} True if the path is valid
   */
  isValidSuggestionPath(suggestionPath, validPaths) {
    // If we couldn't get valid paths, allow all suggestions (fail open for usability)
    // This is a safety fallback - if PR metadata lookup fails, we don't want to
    // discard all suggestions. Log prominently so this is visible for debugging.
    if (!validPaths || (Array.isArray(validPaths) && validPaths.length === 0) || (validPaths instanceof Set && validPaths.size === 0)) {
      logger.warn('[FAILSAFE] Path validation bypassed: no valid paths available. All suggestions will pass through unfiltered.');
      return true;
    }

    // Check if the suggestion path is empty or invalid
    if (!suggestionPath || typeof suggestionPath !== 'string') {
      return false;
    }

    // Use O(1) Set lookup if validPaths is a Set, otherwise normalize and check
    // Resolve git rename syntax so suggestions for renamed files match
    const normalizedSuggestionPath = normalizePath(resolveRenamedFile(suggestionPath));
    if (validPaths instanceof Set) {
      return validPaths.has(normalizedSuggestionPath);
    }
    // Fallback for array (convert to Set for lookup)
    const validPathsSet = new Set(validPaths.map(p => normalizePath(resolveRenamedFile(p))));
    return validPathsSet.has(normalizedSuggestionPath);
  }

  /**
   * Get AI suggestions for a review (PR or local)
   * @param {number} reviewId - Review ID from the reviews table
   * @param {string} [runId] - Optional AI run ID to filter by
   * @returns {Promise<Array>} Array of AI suggestion comments
   */
  async getSuggestions(reviewId, runId = null) {
    const { query } = require('../database');

    let sql = `
      SELECT * FROM comments
      WHERE review_id = ? AND source = 'ai'
    `;
    const params = [reviewId];

    if (runId) {
      sql += ' AND ai_run_id = ?';
      params.push(runId);
    }

    sql += ' ORDER BY file, line_start';

    return await query(this.db, sql, params);
  }


  /**
   * Isolated Level 2 analysis (no auto-chaining)
   * @param {number} prId - Pull request ID
   * @param {string} runId - Analysis run ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} generatedPatterns - Patterns of generated files to skip
   * @param {Function} progressCallback - Callback for progress updates
   * @param {string} customInstructions - Optional custom instructions to include in prompts
   * @param {Array<string>} changedFiles - Optional list of changed files for local mode validation
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel2Isolated(prId, runId, worktreePath, prMetadata, generatedPatterns = [], progressCallback = null, customInstructions = null, changedFiles = null, options = {}) {
    const { analysisId, tier = 'balanced' } = options;
    logger.info('[Level 2] Analysis Starting');

    try {
      // Check if analysis was cancelled before starting
      if (analysisId && isAnalysisCancelled(analysisId)) {
        throw new CancellationError('Analysis was cancelled');
      }

      // Create provider instance for this level
      const aiProvider = createProvider(this.provider, this.model);

      const updateProgress = (step) => {
        const progress = `[Level 2] ${step}...`;

        if (progressCallback) {
          progressCallback({
            status: 'running',
            progress,
            level: 2
          });
        }
        logger.info(progress);
      };

      // Get list of changed files for grounding (use provided list for local mode, or compute for PR mode)
      const validFiles = changedFiles || await this.getChangedFilesList(worktreePath, prMetadata);
      logger.info(`[Level 2] Changed files for grounding: ${validFiles.length} files`);

      // Build the Level 2 prompt
      updateProgress('Building prompt for AI to analyze file context');
      const prompt = this.buildLevel2Prompt(prId, worktreePath, prMetadata, generatedPatterns, customInstructions, validFiles, tier);

      // Execute Claude CLI in the worktree directory
      updateProgress('Running AI to analyze files in context');
      const response = await aiProvider.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000, // 10 minutes for Level 2
        level: 2,
        analysisId,
        registerProcess,
        onStreamEvent: progressCallback ? (event) => {
          progressCallback({ level: 2, status: 'running', streamEvent: event });
        } : undefined
      });

      // Parse and validate the response
      updateProgress('Processing AI results');
      let suggestions = this.parseResponse(response, 2);
      logger.success(`Parsed ${suggestions.length} valid Level 2 suggestions`);

      // Validate suggestion file paths against changed files
      suggestions = this.validateSuggestionFilePaths(suggestions, validFiles);
      logger.success(`After path validation: ${suggestions.length} suggestions`);

      // Store Level 2 suggestions
      updateProgress('Storing Level 2 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 2, validFiles);
      logger.success(`Level 2 complete: ${suggestions.length} suggestions`);

      // Report completion to progress callback
      if (progressCallback) {
        progressCallback({
          status: 'completed',
          progress: `Level 2 complete: ${suggestions.length} suggestions`,
          level: 2
        });
      }

      return {
        suggestions,
        summary: response.summary || `[Level 2] Found ${suggestions.length} file context suggestions`
      };

    } catch (error) {
      // Don't log cancellation as an error - it's expected user behavior
      if (!error.isCancellation) {
        logger.error(`Level 2 analysis failed: ${error.message}`);
      }

      // Report failure to progress callback (unless cancelled)
      if (progressCallback && !error.isCancellation) {
        progressCallback({
          status: 'failed',
          progress: `Level 2 failed: ${error.message}`,
          level: 2
        });
      }

      throw error;
    }
  }

  /**
   * Isolated Level 3 analysis (no auto-chaining)
   * @param {number} prId - Pull request ID
   * @param {string} runId - Analysis run ID
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} prMetadata - PR metadata with base branch info
   * @param {Array} generatedPatterns - Patterns of generated files to skip
   * @param {Function} progressCallback - Callback for progress updates
   * @param {string} customInstructions - Optional custom instructions to include in prompts
   * @param {Array<string>} changedFiles - Optional list of changed files for local mode validation
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeLevel3Isolated(prId, runId, worktreePath, prMetadata, generatedPatterns = [], progressCallback = null, customInstructions = null, changedFiles = null, options = {}) {
    const { analysisId, tier = 'balanced' } = options;
    logger.info('[Level 3] Analysis Starting');

    try {
      // Check if analysis was cancelled before starting
      if (analysisId && isAnalysisCancelled(analysisId)) {
        throw new CancellationError('Analysis was cancelled');
      }

      // Create provider instance for this level
      const aiProvider = createProvider(this.provider, this.model);

      const updateProgress = (step) => {
        const progress = `[Level 3] ${step}...`;

        if (progressCallback) {
          progressCallback({
            status: 'running',
            progress,
            level: 3
          });
        }
        logger.info(progress);
      };

      // Detect testing context
      updateProgress('Detecting testing context for codebase');
      const testingContext = await this.detectTestingContext(worktreePath, prMetadata);

      // Get list of changed files for grounding (use provided list for local mode, or compute for PR mode)
      const validFiles = changedFiles || await this.getChangedFilesList(worktreePath, prMetadata);
      logger.info(`[Level 3] Changed files for grounding: ${validFiles.length} files`);

      // Build the Level 3 prompt with test context
      updateProgress('Building prompt for AI to analyze codebase impact');
      const prompt = await this.buildLevel3Prompt(prId, worktreePath, prMetadata, testingContext, generatedPatterns, customInstructions, validFiles, tier);

      // Execute Claude CLI for Level 3 analysis
      updateProgress('Running AI to analyze codebase-wide implications');
      const response = await aiProvider.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000, // 10 minutes for Level 3
        level: 3,
        analysisId,
        registerProcess,
        onStreamEvent: progressCallback ? (event) => {
          progressCallback({ level: 3, status: 'running', streamEvent: event });
        } : undefined
      });

      // Parse and validate the response
      updateProgress('Processing codebase context results');
      let suggestions = this.parseResponse(response, 3);
      logger.success(`Parsed ${suggestions.length} valid Level 3 suggestions`);

      // Validate suggestion file paths against changed files
      suggestions = this.validateSuggestionFilePaths(suggestions, validFiles);
      logger.success(`After path validation: ${suggestions.length} suggestions`);

      // Store Level 3 suggestions
      updateProgress('Storing Level 3 suggestions in database');
      await this.storeSuggestions(prId, runId, suggestions, 3, validFiles);
      logger.success(`Level 3 complete: ${suggestions.length} suggestions`);

      // Report completion to progress callback
      if (progressCallback) {
        progressCallback({
          status: 'completed',
          progress: `Level 3 complete: ${suggestions.length} suggestions`,
          level: 3
        });
      }

      return {
        suggestions,
        summary: response.summary || `[Level 3] Found ${suggestions.length} codebase context suggestions`
      };

    } catch (error) {
      // Don't log cancellation as an error - it's expected user behavior
      if (!error.isCancellation) {
        logger.error(`Level 3 analysis failed: ${error.message}`);
      }

      // Report failure to progress callback (unless cancelled)
      if (progressCallback && !error.isCancellation) {
        progressCallback({
          status: 'failed',
          progress: `Level 3 failed: ${error.message}`,
          level: 3
        });
      }

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
      // For local mode, use git diff HEAD; for PR mode, use base...head
      const diffCmd = this.buildGitDiffCommand(prMetadata, '--name-only');
      const { stdout: changedFiles } = await execPromise(diffCmd, { cwd: worktreePath });
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
  determineTestFramework(language, foundFiles, _worktreePath) {
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

  async buildLevel3Prompt(prId, worktreePath, prMetadata, testingContext = null, generatedPatterns = [], customInstructions = null, changedFiles = [], tier = 'balanced') {
    logger.debug(`[Level 3] Building prompt with tier: ${tier}`);
    // Try new prompt architecture first
    const promptBuilder = getPromptBuilder('level3', tier, this.provider);

    if (promptBuilder) {
      // Build context for the new tagged prompt system
      const criticalNote = `Treat this description as the author's CLAIM about what they changed and why. At this architectural level, it's especially important to verify alignment between stated intent and actual implementation. Flag any:
- **Architectural discrepancies:** Does the implementation match the architectural approach described?
- **Scope misalignment:** Are there changes beyond what's described, or is described functionality missing?
- **Impact inconsistencies:** Does the actual codebase impact match what the author claimed?
- **Undocumented side effects:** Are there broader impacts not mentioned in the description?`;

      // Note: Level 3 uses "changedFiles" key to match the {{changedFiles}} placeholder in Level 3 prompts.
      // Level 1/2 use "validFiles" key for their {{validFiles}} placeholder. Same underlying data,
      // different naming to reflect semantic intent: L3 emphasizes "changed files in this PR" (context
      // perspective for architectural analysis), while L1/L2 emphasize "valid files for suggestions"
      // (constraint perspective for focused analysis).
      const context = {
        reviewIntro: this.buildReviewIntroduction(prId, prMetadata),
        prContext: this.buildPRContextSection(prMetadata, criticalNote),
        customInstructions: this.buildCustomInstructionsSection(customInstructions),
        lineNumberGuidance: this.buildLineNumberGuidance(worktreePath),
        sparseCheckoutGuidance: await this.buildSparseCheckoutGuidanceSection(worktreePath),
        generatedFiles: this.buildGeneratedFilesExclusionSection(generatedPatterns),
        changedFiles: formatValidFiles(changedFiles),
        testingGuidance: this.buildTestAnalysisSection(testingContext)
      };

      logger.debug('[Level 3] Using new prompt architecture');
      return promptBuilder.build(context);
    }

    // Fallback to legacy implementation if prompt not migrated
    logger.debug('[Level 3] Using legacy prompt implementation');
    const prContext = this.buildPRContextSection(prMetadata,
      `Treat this description as the author's CLAIM about what they changed and why. At this architectural level, it's especially important to verify alignment between stated intent and actual implementation. Flag any:
- **Architectural discrepancies:** Does the implementation match the architectural approach described?
- **Scope misalignment:** Are there changes beyond what's described, or is described functionality missing?
- **Impact inconsistencies:** Does the actual codebase impact match what the author claimed?
- **Undocumented side effects:** Are there broader impacts not mentioned in the description?`);

    const generatedFilesSection = this.buildGeneratedFilesExclusionSection(generatedPatterns);
    const customInstructionsSection = this.buildCustomInstructionsSection(customInstructions);
    const changedFilesSection = this.buildChangedFilesSection(changedFiles);
    const lineNumberGuidance = this.buildLineNumberGuidance(worktreePath);

    return `${this.buildReviewIntroduction(prId, prMetadata)}
${prContext}${customInstructionsSection}# Level 3 Review - Analyze Change Impact on Codebase
${lineNumberGuidance}
${generatedFilesSection}${changedFilesSection}
## Purpose
Level 3 analyzes how the changes connect to and impact the broader codebase.
This is NOT a general codebase review or architectural audit.
Focus on understanding the relationships between these specific changes and existing code.

## Analysis Process
Start from the changed files and explore outward to understand connections:
   - How these changes interact with files that reference them or are referenced by changed files
   - How these changes relate to tests, configurations, and documentation
   - Whether these changes follow, improve, or violate patterns established elsewhere in the codebase
   - What impact these changes have on other parts of the system

Explore as deeply as needed to understand the impact, but stay focused on relationships to the PR changes.
Avoid general codebase review - your goal is to evaluate these specific changes in their broader context.

## Focus Areas
Analyze how these changes affect or relate to:
   - Existing architecture: do these changes fit with, improve, or disrupt architectural patterns?
   - Established patterns: do these changes follow, improve, or violate patterns used elsewhere in the codebase?
   - Cross-file dependencies: how do these changes impact other files that depend on them?
   - ${this.buildTestAnalysisSection(testingContext)}
   - Documentation: do these changes require updates to docs? Are they consistent with documented APIs?
   - API contracts: do these changes maintain or improve consistency with existing API patterns?
   - Configuration: do these changes necessitate configuration updates?
   - Environment compatibility: how do these changes behave across different environments?
   - Breaking changes: do these changes break existing functionality or contracts?
   - Backward compatibility: do these changes maintain compatibility with prior versions?
   - Performance of connected components: how do these changes affect performance elsewhere?
   - System scalability: how do these changes impact the system's ability to scale?
   - Security of connected systems: do these changes introduce security risks in other parts?
   - Data flow security: how do these changes affect security across data flows?

## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- find . -name "*.test.js" or similar to find test files
- grep -r "pattern" to search for patterns
- \`cat -n <file>\` to view files with line numbers
- ls, tree commands to explore structure
- Any other read-only commands needed to understand how changes connect to the codebase

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to explore different areas of the codebase if that would be helpful.

## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
{
  "level": 3,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why codebase context was needed",
    "suggestion": "How to fix/improve based on codebase context (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation from codebase perspective",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of how these changes connect to and impact the codebase"
}

## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number. This is correct for:
  - ADDED lines marked with [+]
  - CONTEXT lines (unchanged lines that appear in both versions)
- **"OLD"**: Use the OLD column number. ONLY use this for DELETED lines marked with [-].

**IMPORTANT**: Context lines exist in BOTH the old and new file - always use "NEW" for context lines.
Only use "OLD" when the line is prefixed with [-] indicating it was deleted.

If you are unsure, use "NEW" - it is correct for the vast majority of suggestions.

## File-Level Suggestions
In addition to line-specific suggestions, you may include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines, such as:
- Architectural concerns about the file's role in the codebase
- Missing tests for the file's functionality
- Integration issues with other parts of the codebase
- File-level design pattern inconsistencies with the rest of the codebase
- Documentation gaps for the file
- Organizational issues (file location, module structure)

File-level suggestions should NOT have a line number. They apply to the entire file.

## Important Guidelines
- You may attach line-specific suggestions to any line within files touched by this PR, including unchanged context lines when analysis reveals issues.
- Focus on how these changes interact with the broader codebase
- Look especially for ${testingContext?.shouldCheckTests ? 'missing tests,' : ''} documentation, and integration issues
- For "praise" type: Omit the suggestion field entirely to save tokens
- For other types: Include specific, actionable suggestions`;
  }

  /**
   * Orchestrate all suggestions using AI to provide intelligent curation and merging
   * @param {Object} allSuggestions - Object containing suggestions from all levels: {level1: [...], level2: [...], level3: [...]}
   * @param {Object} prMetadata - PR metadata for context
   * @param {string} customInstructions - Optional custom instructions to guide prioritization/filtering
   * @param {string} worktreePath - Path to the git worktree
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @returns {Promise<Array>} Curated suggestions array
   */
  async orchestrateWithAI(allSuggestions, prMetadata, customInstructions = null, worktreePath = null, options = {}) {
    const { analysisId, tier = 'balanced', progressCallback, providerOverride, modelOverride } = options;
    logger.section('[Orchestration] AI Orchestration Starting');

    const totalSuggestions = (allSuggestions.level1?.length || 0) +
                           (allSuggestions.level2?.length || 0) +
                           (allSuggestions.level3?.length || 0);

    logger.info(`[Orchestration] Orchestrating ${totalSuggestions} total suggestions across all levels`);

    try {
      // Check if analysis was cancelled before starting
      if (analysisId && isAnalysisCancelled(analysisId)) {
        throw new CancellationError('Analysis was cancelled');
      }

      // Create provider instance for orchestration (use overrides if provided)
      const aiProvider = createProvider(providerOverride || this.provider, modelOverride || this.model);

      // Build the orchestration prompt
      const prompt = this.buildOrchestrationPrompt(allSuggestions, prMetadata, customInstructions, worktreePath, tier);

      // Execute Claude CLI for orchestration
      logger.info('[Orchestration] Running AI orchestration to curate and merge suggestions...');
      const response = await aiProvider.execute(prompt, {
        timeout: 600000, // 10 minutes for orchestration
        level: 'orchestration',
        analysisId,
        registerProcess,
        onStreamEvent: progressCallback ? (event) => {
          progressCallback({ level: 'orchestration', status: 'running', streamEvent: event });
        } : undefined
      });

      // Parse the orchestrated response
      const orchestratedSuggestions = this.parseResponse(response, 'orchestration');

      // Debug: If orchestration returned 0 suggestions but there was input, log for investigation
      const inputLevel1Count = allSuggestions.level1?.length || 0;
      const inputLevel2Count = allSuggestions.level2?.length || 0;
      const inputLevel3Count = allSuggestions.level3?.length || 0;
      const hadInputSuggestions = inputLevel1Count > 0 || inputLevel2Count > 0 || inputLevel3Count > 0;

      if (orchestratedSuggestions.length === 0 && hadInputSuggestions) {
        logger.warn('[Orchestration] WARNING: Orchestration returned 0 suggestions despite input');
        logger.warn(`[Orchestration] Input suggestion counts: Level1=${inputLevel1Count}, Level2=${inputLevel2Count}, Level3=${inputLevel3Count}`);
        if (response.raw) {
          logger.warn('[Orchestration] Raw AI response for debugging:');
          logger.warn('--- BEGIN RAW ORCHESTRATION RESPONSE ---');
          logger.warn(response.raw);
          logger.warn('--- END RAW ORCHESTRATION RESPONSE ---');
        } else if (response.suggestions) {
          logger.warn('[Orchestration] Response had suggestions array but parsing returned 0. Response.suggestions:');
          logger.warn(JSON.stringify(response.suggestions, null, 2));
        } else {
          logger.warn('[Orchestration] Response object keys: ' + Object.keys(response).join(', '));
        }
      }

      // Extract summary from the orchestration response
      let summary = `Analyzed PR with ${orchestratedSuggestions.length} curated suggestions`;
      if (response.summary) {
        summary = response.summary;
      } else if (response.raw) {
        const extracted = extractJSON(response.raw, 'orchestration');
        if (extracted.success && extracted.data.summary) {
          summary = extracted.data.summary;
        }
      }

      logger.success(`[Orchestration] AI orchestration complete: ${orchestratedSuggestions.length} curated suggestions`);

      return {
        suggestions: orchestratedSuggestions,
        summary: summary
      };
      
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

      return {
        suggestions: fallbackSuggestions,
        summary: `Analysis complete (orchestration failed): ${fallbackSuggestions.length} suggestions from all analysis levels`
      };
    }
  }

  /**
   * Format suggestions for display in orchestration prompt
   * @param {Array} suggestions - Array of suggestion objects
   * @returns {string} Formatted string for prompt
   */
  _formatSuggestionsForOrchestration(suggestions) {
    if (!suggestions || suggestions.length === 0) {
      return '[]';
    }
    return JSON.stringify(suggestions, null, 2);
  }

  /**
   * Build orchestration prompt for intelligent suggestion curation
   * @param {Object} allSuggestions - Suggestions from all levels
   * @param {Object} prMetadata - PR metadata for context
   * @param {string} customInstructions - Optional custom instructions to guide prioritization/filtering
   * @param {string} worktreePath - Path to the git worktree
   * @param {string} tier - Capability tier: 'fast', 'balanced', or 'thorough' (default: 'balanced')
   * @returns {string} Orchestration prompt
   */
  buildOrchestrationPrompt(allSuggestions, prMetadata, customInstructions = null, worktreePath = null, tier = 'balanced') {
    logger.debug(`[Orchestration] Building prompt with tier: ${tier}`);
    const promptBuilder = getPromptBuilder('orchestration', tier, this.provider);

    // Build context for the tagged prompt system
    const isLocal = prMetadata.reviewType === 'local';
    const reviewDescription = isLocal
      ? `local changes (review #${prMetadata.number || 'local'})`
      : `pull request #${prMetadata.number}`;

    const context = {
      reviewIntro: `You are orchestrating AI-powered code review suggestions for ${reviewDescription}.`,
      customInstructions: customInstructions ? this.buildCustomInstructionsSection(customInstructions) : '',
      lineNumberGuidance: this.buildOrchestrationLineNumberGuidance(worktreePath),
      level1Count: allSuggestions.level1?.length || 0,
      level2Count: allSuggestions.level2?.length || 0,
      level3Count: allSuggestions.level3?.length || 0,
      level1Suggestions: this._formatSuggestionsForOrchestration(allSuggestions.level1),
      level2Suggestions: this._formatSuggestionsForOrchestration(allSuggestions.level2),
      level3Suggestions: this._formatSuggestionsForOrchestration(allSuggestions.level3)
    };

    return promptBuilder.build(context);
  }


  /**
   * Run a council analysis with multiple voices across configurable levels
   *
   * @param {Object} reviewContext - Context for the review
   * @param {number} reviewContext.reviewId - Review ID (from reviews table)
   * @param {string} reviewContext.worktreePath - Path to the git worktree
   * @param {Object} reviewContext.prMetadata - PR/review metadata
   * @param {Array<string>} [reviewContext.changedFiles] - Changed files list
   * @param {Object} reviewContext.instructions - Instructions object { repoInstructions, requestInstructions }
   * @param {Object} councilConfig - Council configuration
   * @param {Object} councilConfig.levels - Level configurations keyed by '1', '2', '3'
   * @param {Object} [councilConfig.orchestration] - Orchestration provider/model/tier
   * @param {Object} options - Additional options
   * @param {string} options.analysisId - Analysis ID for process tracking
   * @param {string} [options.runId] - Pre-generated run ID
   * @param {Function} [options.progressCallback] - Progress callback
   * @returns {Promise<Object>} Analysis results
   */
  async runCouncilAnalysis(reviewContext, councilConfig, options = {}) {
    const { reviewId, worktreePath, prMetadata, changedFiles, instructions } = reviewContext;
    const { analysisId, progressCallback } = options;
    const runId = options.runId || uuidv4();

    logger.section('Review Council Analysis Starting');
    logger.info(`Review ID: ${reviewId}, Run ID: ${runId}`);

    // Merge instructions
    const { mergeInstructions } = require('../utils/instructions');
    let mergedInstructions = null;
    if (instructions && typeof instructions === 'object') {
      mergedInstructions = mergeInstructions(instructions.repoInstructions, instructions.requestInstructions);
    }

    // Load generated file patterns
    const generatedPatterns = await this.loadGeneratedFilePatterns(worktreePath);

    // Get changed files for validation
    const validFiles = changedFiles || await this.getChangedFilesList(worktreePath, prMetadata);
    logger.info(`[Council] Using ${validFiles.length} changed files for path validation`);

    // Build file line count map for validation
    const { buildFileLineCountMap } = require('../utils/line-validation');
    const fileLineCountMap = await buildFileLineCountMap(worktreePath, validFiles);

    // Collect all voice tasks across enabled levels
    const voiceTasks = [];
    const enabledLevels = [];

    for (const [levelKey, levelConfig] of Object.entries(councilConfig.levels)) {
      if (!levelConfig.enabled) continue;
      enabledLevels.push(parseInt(levelKey));

      for (const [voiceIdx, voice] of levelConfig.voices.entries()) {
        const voiceId = `L${levelKey}-${voice.provider}-${voice.model}${voiceIdx > 0 ? `-${voiceIdx}` : ''}`;
        const tier = voice.tier || 'balanced';

        // Merge per-voice custom instructions with base instructions
        let voiceInstructions = mergedInstructions;
        if (voice.customInstructions) {
          voiceInstructions = voiceInstructions
            ? `${voiceInstructions}\n\n${voice.customInstructions}`
            : voice.customInstructions;
        }

        voiceTasks.push({
          voiceId,
          level: parseInt(levelKey),
          provider: voice.provider,
          model: voice.model,
          tier,
          customInstructions: voiceInstructions
        });
      }
    }

    if (voiceTasks.length === 0) {
      throw new Error('No enabled levels with voices in council config');
    }

    logger.info(`[Council] Launching ${voiceTasks.length} voice(s) across levels: ${enabledLevels.join(', ')}`);

    // Execute all voices in parallel
    const voicePromises = voiceTasks.map(task => {
      return this._executeCouncilVoice(task, {
        reviewId, runId, worktreePath, prMetadata,
        generatedPatterns, validFiles, analysisId, progressCallback
      });
    });

    const voiceResults = await Promise.allSettled(voicePromises);

    // Check for cancellation
    const hasCancellation = voiceResults.some(
      r => r.status === 'rejected' && r.reason?.isCancellation
    );
    if (hasCancellation) {
      throw new CancellationError('Council analysis cancelled by user');
    }

    // Collect results per level, including voice summaries
    const levelSuggestions = {};
    const voiceSummaries = [];
    const rawSuggestions = [];
    let voiceSuccessCount = 0;

    for (let i = 0; i < voiceTasks.length; i++) {
      const task = voiceTasks[i];
      const result = voiceResults[i];

      if (result.status === 'fulfilled' && result.value.suggestions) {
        const suggestions = result.value.suggestions;
        voiceSuccessCount++;

        // Capture voice summary (voices may produce summaries even with 0 suggestions)
        if (result.value.summary) {
          voiceSummaries.push(result.value.summary);
        }

        // Tag each suggestion with voice_id, level, and mark as raw
        const taggedSuggestions = suggestions.map(s => ({
          ...s,
          voice_id: task.voiceId,
          level: task.level,
          is_raw: 1
        }));

        rawSuggestions.push(...taggedSuggestions);

        if (!levelSuggestions[task.level]) {
          levelSuggestions[task.level] = [];
        }
        levelSuggestions[task.level].push(...suggestions);

        logger.success(`[Council] Voice ${task.voiceId}: ${suggestions.length} suggestions`);
      } else {
        const reason = result.status === 'rejected' ? result.reason?.message : 'No suggestions';
        logger.warn(`[Council] Voice ${task.voiceId} failed: ${reason}`);
      }
    }

    if (voiceSuccessCount === 0) {
      throw new Error('All council voices failed');
    }

    // Pick the best available voice summary for bypass paths.
    // When consolidation/orchestration is skipped, we use the first real voice summary
    // rather than a generic placeholder, so AI-generated summaries aren't lost.
    const bestVoiceSummary = voiceSummaries.length > 0 ? voiceSummaries[0] : null;

    // Check if we can skip ALL consolidation
    // Use voiceSuccessCount (not just voices with >0 suggestions) so a single voice
    // returning 0 suggestions but a summary still takes the fast path
    const enabledLevelsWithResults = Object.keys(levelSuggestions).map(Number);
    const successfulVoiceLevels = new Set();
    for (let i = 0; i < voiceTasks.length; i++) {
      if (voiceResults[i].status === 'fulfilled' && voiceResults[i].value.suggestions) {
        successfulVoiceLevels.add(voiceTasks[i].level);
      }
    }

    if (voiceSuccessCount === 1 && successfulVoiceLevels.size === 1) {
      // Single voice, single level — skip all consolidation
      logger.info('[Council] Single voice result — skipping consolidation');
      const singleLevel = [...successfulVoiceLevels][0];
      const singleLevelSuggestions = levelSuggestions[singleLevel] || [];
      const finalSuggestions = this.validateAndFinalizeSuggestions(
        singleLevelSuggestions, fileLineCountMap, validFiles
      );
      await this.storeSuggestions(reviewId, runId, finalSuggestions, null, validFiles);

      return {
        runId,
        suggestions: finalSuggestions,
        summary: bestVoiceSummary || `Council analysis complete: ${finalSuggestions.length} suggestions from single voice`
      };
    }

    // Check if total suggestion count is below consolidation threshold
    const totalSuggestionCount = Object.values(levelSuggestions).reduce((sum, arr) => sum + arr.length, 0);
    if (totalSuggestionCount < COUNCIL_CONSOLIDATION_THRESHOLD) {
      logger.info(`[Council] ${totalSuggestionCount} total suggestions below threshold (${COUNCIL_CONSOLIDATION_THRESHOLD}) — skipping consolidation`);
      const allSuggestions = Object.values(levelSuggestions).flat();
      const finalSuggestions = this.validateAndFinalizeSuggestions(
        allSuggestions, fileLineCountMap, validFiles
      );
      await this.storeSuggestions(reviewId, runId, finalSuggestions, null, validFiles);

      // Prefer voice summaries over generic placeholders. When multiple voices
      // produced summaries, join them so no insight is lost.
      const thresholdSummary = voiceSummaries.length > 1
        ? voiceSummaries.join('\n\n')
        : bestVoiceSummary;

      return {
        runId,
        suggestions: finalSuggestions,
        summary: thresholdSummary || `Council analysis complete: ${finalSuggestions.length} suggestions (consolidation skipped — below threshold)`
      };
    }

    // Store raw per-voice suggestions (only when consolidation will occur)
    logger.info(`[Council] Storing ${rawSuggestions.length} raw voice suggestions`);
    await this._storeCouncilSuggestions(reviewId, runId, rawSuggestions, validFiles);

    // Determine orchestration provider
    const orchConfig = councilConfig.orchestration || this._defaultOrchestration(councilConfig);
    const orchProvider = orchConfig.provider;
    const orchModel = orchConfig.model;
    const orchTier = orchConfig.tier || 'balanced';

    logger.info(`[Council] Orchestration: ${orchProvider}/${orchModel} (${orchTier})`);

    if (progressCallback) {
      progressCallback({
        status: 'running',
        progress: 'Consolidating council results...',
        level: 'orchestration'
      });
    }

    // Pass 1: Intra-level consolidation (for levels with >1 voice)
    const consolidatedPerLevel = {};
    for (const [levelStr, suggestions] of Object.entries(levelSuggestions)) {
      const level = parseInt(levelStr);
      const successfulVoicesForLevel = voiceTasks
        .map((t, idx) => ({ t, idx }))
        .filter(({ t, idx }) =>
          t.level === level &&
          voiceResults[idx].status === 'fulfilled' &&
          voiceResults[idx].value.suggestions?.length > 0
        );

      if (successfulVoicesForLevel.length <= 1) {
        // Single voice or no results — no intra-level consolidation needed
        consolidatedPerLevel[level] = suggestions;
      } else {
        // Multiple voices — run intra-level consolidation
        logger.info(`[Council] Pass 1: Consolidating ${successfulVoicesForLevel.length} voices for Level ${level}`);
        try {
          const consolidated = await this._intraLevelConsolidate(
            level, suggestions, prMetadata, mergedInstructions, worktreePath,
            { provider: orchProvider, model: orchModel, tier: orchTier, analysisId, progressCallback }
          );
          consolidatedPerLevel[level] = consolidated;
        } catch (error) {
          logger.warn(`[Council] Intra-level consolidation failed for Level ${level}: ${error.message}`);
          consolidatedPerLevel[level] = suggestions; // Fallback to raw
        }
      }
    }

    // Pass 2: Cross-level orchestration
    logger.info('[Council] Pass 2: Cross-level orchestration');
    try {
      const allSuggestions = {
        level1: consolidatedPerLevel[1] || [],
        level2: consolidatedPerLevel[2] || [],
        level3: consolidatedPerLevel[3] || []
      };

      const orchestrationResult = await this.orchestrateWithAI(
        allSuggestions, prMetadata, mergedInstructions, worktreePath,
        { analysisId, tier: orchTier, progressCallback, providerOverride: orchProvider, modelOverride: orchModel }
      );

      const finalSuggestions = this.validateAndFinalizeSuggestions(
        orchestrationResult.suggestions, fileLineCountMap, validFiles
      );

      // Store final consolidated suggestions (is_raw=0, voice_id=null)
      await this.storeSuggestions(reviewId, runId, finalSuggestions, null, validFiles);

      logger.success(`[Council] Analysis complete: ${finalSuggestions.length} final suggestions`);

      return {
        runId,
        suggestions: finalSuggestions,
        summary: orchestrationResult.summary
      };
    } catch (error) {
      logger.error(`[Council] Cross-level orchestration failed: ${error.message}`);

      // Fallback: combine all consolidated suggestions
      const fallbackSuggestions = Object.values(consolidatedPerLevel).flat();
      const finalFallback = this.validateAndFinalizeSuggestions(
        fallbackSuggestions, fileLineCountMap, validFiles
      );
      await this.storeSuggestions(reviewId, runId, finalFallback, null, validFiles);

      return {
        runId,
        suggestions: finalFallback,
        summary: `Council analysis complete (orchestration failed): ${finalFallback.length} suggestions`,
        orchestrationFailed: true
      };
    }
  }

  /**
   * Execute a single council voice
   * @param {Object} task - Voice task configuration
   * @param {Object} context - Shared context
   * @returns {Promise<Object>} Voice results { suggestions, summary }
   * @private
   */
  async _executeCouncilVoice(task, context) {
    const { voiceId, level, provider, model, tier, customInstructions } = task;
    const { reviewId, runId, worktreePath, prMetadata, generatedPatterns, validFiles, analysisId, progressCallback } = context;

    logger.info(`[Council] Starting voice ${voiceId} (Level ${level}, ${provider}/${model}, ${tier})`);

    if (analysisId && isAnalysisCancelled(analysisId)) {
      throw new CancellationError('Analysis was cancelled');
    }

    // Create provider instance for this voice
    const aiProvider = createProvider(provider, model);

    // Build prompt based on level
    let prompt;
    if (level === 1) {
      prompt = this.buildLevel1Prompt(reviewId, worktreePath, prMetadata, generatedPatterns, customInstructions, validFiles, tier);
    } else if (level === 2) {
      prompt = this.buildLevel2Prompt(reviewId, worktreePath, prMetadata, generatedPatterns, customInstructions, validFiles, tier);
    } else if (level === 3) {
      // Level 3 is async and has a testingContext parameter (null for council voices)
      prompt = await this.buildLevel3Prompt(reviewId, worktreePath, prMetadata, null, generatedPatterns, customInstructions, validFiles, tier);
    }

    // Execute
    try {
      const response = await aiProvider.execute(prompt, {
        cwd: worktreePath,
        timeout: 600000,
        level,
        analysisId,
        registerProcess,
        onStreamEvent: progressCallback ? (event) => {
          progressCallback({ level, status: 'running', streamEvent: event, voiceId });
        } : undefined
      });

      // Parse response
      const suggestions = this.parseResponse(response, level);
      logger.success(`[Council] Voice ${voiceId}: parsed ${suggestions.length} suggestions`);

      // Report per-voice completion to progress callback
      if (progressCallback) {
        progressCallback({
          status: 'completed',
          progress: `${suggestions.length} suggestions`,
          level,
          voiceId
        });
      }

      return {
        suggestions,
        summary: response.summary || `Voice ${voiceId}: ${suggestions.length} suggestions`
      };
    } catch (error) {
      if (!error.isCancellation) {
        logger.error(`[Council] Voice ${voiceId} failed: ${error.message}`);
      }

      // Report per-voice failure to progress callback (unless cancelled)
      if (progressCallback && !error.isCancellation) {
        progressCallback({
          status: 'failed',
          progress: `Failed: ${error.message}`,
          level,
          voiceId
        });
      }

      throw error;
    }
  }

  /**
   * Run intra-level consolidation for a level with multiple voices
   * @param {number} level - Analysis level
   * @param {Array} suggestions - Combined suggestions from all voices at this level
   * @param {Object} prMetadata - PR metadata
   * @param {string} customInstructions - Custom instructions
   * @param {string} worktreePath - Worktree path
   * @param {Object} orchConfig - Orchestration config { provider, model, tier, analysisId, progressCallback }
   * @returns {Promise<Array>} Consolidated suggestions
   * @private
   */
  async _intraLevelConsolidate(level, suggestions, prMetadata, customInstructions, worktreePath, orchConfig) {
    const { provider, model, tier, analysisId, progressCallback } = orchConfig;

    const aiProvider = createProvider(provider, model);

    const prompt = `You are consolidating code review suggestions from multiple AI reviewers for Level ${level} analysis.

Multiple reviewers have independently analyzed the same code changes. Your job is to:
1. **Deduplicate**: Merge suggestions that identify the same issue
2. **Resolve conflicts**: When reviewers disagree, use your judgment to pick the better analysis
3. **Preserve unique insights**: Keep suggestions that only one reviewer noticed
4. **Maintain quality**: Only include suggestions with sufficient confidence

## Input Suggestions (${suggestions.length} total from multiple reviewers)
${JSON.stringify(suggestions)}

## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks.

{
  "suggestions": [
    {
      "file": "path/to/file",
      "line": 42,
      "old_or_new": "NEW",
      "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
      "title": "Brief title",
      "description": "Detailed explanation",
      "suggestion": "How to fix/improve (omit for praise)",
      "confidence": 0.0-1.0
    }
  ],
  "summary": "Brief consolidation summary"
}`;

    const response = await aiProvider.execute(prompt, {
      cwd: worktreePath,
      timeout: 300000,
      level: `consolidation-L${level}`,
      analysisId,
      registerProcess,
      onStreamEvent: progressCallback ? (event) => {
        progressCallback({ level: `consolidation-L${level}`, status: 'running', streamEvent: event });
      } : undefined
    });

    return this.parseResponse(response, level);
  }

  /**
   * Store council suggestions with voice_id and is_raw fields
   * @param {number} reviewId - Review ID
   * @param {string} runId - Analysis run ID
   * @param {Array} suggestions - Suggestions with voice_id and is_raw fields
   * @param {Array<string>} validFiles - Valid file paths
   * @private
   */
  async _storeCouncilSuggestions(reviewId, runId, suggestions, validFiles) {
    const { run: dbRun } = require('../database');

    // FAILSAFE: Filter suggestions to only those with valid file paths (same as storeSuggestions)
    const validPathsSet = new Set(validFiles.map(f => normalizePath(resolveRenamedFile(f))));
    let filteredCount = 0;

    for (const suggestion of suggestions) {
      // Validate file path against changed files
      if (!this.isValidSuggestionPath(suggestion.file, validPathsSet)) {
        filteredCount++;
        continue;
      }

      const body = suggestion.description +
        (suggestion.suggestion ? '\n\n**Suggestion:** ' + suggestion.suggestion : '');

      const isFileLevel = suggestion.is_file_level === true || suggestion.line_start === null ? 1 : 0;
      const side = suggestion.old_or_new === 'OLD' ? 'LEFT' : 'RIGHT';

      await dbRun(this.db, `
        INSERT INTO comments (
          review_id, source, author, ai_run_id, ai_level, ai_confidence,
          file, line_start, line_end, side, type, title, body, status, is_file_level,
          voice_id, is_raw
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        reviewId,
        'ai',
        'AI Assistant',
        runId,
        suggestion.level || null, // ai_level
        suggestion.confidence,
        suggestion.file,
        suggestion.line_start,
        suggestion.line_end,
        side,
        suggestion.type,
        suggestion.title,
        body,
        'active',
        isFileLevel,
        suggestion.voice_id || null,
        suggestion.is_raw || 0
      ]);
    }

    if (filteredCount > 0) {
      logger.warn(`[Council] Filtered ${filteredCount} raw suggestions with invalid file paths`);
    }
    logger.info(`[Council] Stored ${suggestions.length - filteredCount} raw voice suggestions`);
  }

  /**
   * Derive default orchestration config from the council config
   * @param {Object} councilConfig - Council configuration
   * @returns {Object} Default orchestration { provider, model, tier }
   * @private
   */
  _defaultOrchestration(councilConfig) {
    // Find the first enabled level with voices
    for (const levelKey of ['1', '2', '3']) {
      const level = councilConfig.levels[levelKey];
      if (level?.enabled && level.voices?.length > 0) {
        const firstVoice = level.voices[0];
        return {
          provider: firstVoice.provider,
          model: firstVoice.model,
          tier: firstVoice.tier || 'balanced'
        };
      }
    }

    // Fallback to claude/sonnet
    return { provider: 'claude', model: 'sonnet', tier: 'balanced' };
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