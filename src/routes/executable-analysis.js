// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared lifecycle for executable provider analysis
 *
 * Both local and PR analysis routes follow the same steps when running an
 * executable (external-tool) provider.  This module captures that shared
 * lifecycle so neither route duplicates it.
 *
 * Mode-specific behaviour is injected via the `callbacks` parameter:
 *   - buildContext(review, extra)      – returns the full executableContext object
 *                                        `extra` contains { selectedModel, requestInstructions }
 *   - buildHookPayload(review, extra)  – returns the mode-specific hook payload fields
 *   - onSuccess(db, runId, result)     – persists mode-specific artefacts on success
 *   - logLabel                         – short string for log messages (e.g. "PR #42")
 */

const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);
const fsPromises = require('fs').promises;
const logger = require('../utils/logger');
const { createProvider } = require('../ai/provider');
const { AnalysisRunRepository, CommentRepository } = require('../database');
const { fireHooks, hasHooks } = require('../hooks/hook-runner');
const { buildAnalysisStartedPayload, buildAnalysisCompletedPayload, getCachedUser } = require('../hooks/payloads');
const { normalizePath, resolveRenamedFile } = require('../utils/paths');
const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('../utils/line-validation');
const { GIT_DIFF_FLAGS } = require('../git/diff-flags');
const { generateScopedDiff, findMergeBase } = require('../local-review');
const { scopeIncludes } = require('../local-scope');

/**
 * Generate a diff for the executable provider and write it to a file.
 *
 * PR mode: uses baseSha...headSha (three-dot merge-base diff).
 * Local mode: scope-aware diff via generateScopedDiff.
 *
 * Uses GIT_DIFF_FLAGS for normalized output and git-default context (3 lines).
 * Additional flags can be passed via diffArgs (from provider config.diff_args).
 *
 * @param {string} cwd - Working directory (repo path)
 * @param {Object} context - Executable context
 * @param {string|null} context.baseSha - Base SHA (PR mode)
 * @param {string|null} context.headSha - Head SHA (PR mode)
 * @param {string|null} context.scopeStart - Scope start stop (local mode)
 * @param {string|null} context.scopeEnd - Scope end stop (local mode)
 * @param {string|null} context.baseBranch - Base branch (local mode, for merge-base)
 * @param {string[]} diffArgs - Extra git diff flags from provider config
 * @param {string} outputPath - Path to write the diff file
 * @returns {Promise<string>} The diff content
 */
async function generateDiffForExecutable(cwd, context, diffArgs, outputPath) {
  let diff;
  const extraFlags = diffArgs.length > 0 ? ' ' + diffArgs.join(' ') : '';

  if (context.baseSha && context.headSha) {
    // PR mode: straightforward base...head diff
    const { stdout } = await execPromise(
      `git diff ${GIT_DIFF_FLAGS}${extraFlags} ${context.baseSha}...${context.headSha}`,
      { cwd, maxBuffer: 50 * 1024 * 1024 }
    );
    diff = stdout;
  } else if (context.scopeStart && context.scopeEnd) {
    // Local mode: scope-aware diff generation
    // Note: diffArgs are passed as extraArgs to generateScopedDiff, which handles
    // appending them to the git diff command internally (extraFlags is not used here).
    const result = await generateScopedDiff(
      cwd,
      context.scopeStart,
      context.scopeEnd,
      context.baseBranch || null,
      { contextLines: 3, extraArgs: diffArgs }
    );
    diff = result.diff;
  } else {
    // Fallback: simple working-tree diff
    const { stdout } = await execPromise(
      `git diff ${GIT_DIFF_FLAGS}${extraFlags}`,
      { cwd, maxBuffer: 50 * 1024 * 1024 }
    );
    diff = stdout;
  }

  await fsPromises.writeFile(outputPath, diff || '', 'utf-8');
  return diff;
}

/**
 * Get the list of changed files from git for suggestion validation.
 * PR mode uses base...head diff.
 * Local mode is scope-aware: only includes files from the scope stops
 * (branch, staged, unstaged, untracked) that were included in the diff.
 * @param {string} cwd - Working directory
 * @param {Object} context - Executable context with baseSha/headSha or scope fields
 * @returns {Promise<string[]>} Changed file paths
 */
async function getChangedFiles(cwd, context) {
  try {
    if (context.baseSha && context.headSha) {
      const { stdout } = await execPromise(
        `git diff ${GIT_DIFF_FLAGS} ${context.baseSha}...${context.headSha} --name-only`,
        { cwd }
      );
      return stdout.trim().split('\n').filter(f => f.length > 0);
    }

    // Local mode: scope-aware file list
    const { scopeStart, scopeEnd, baseBranch } = context;
    const commands = [];

    if (scopeStart && scopeEnd) {
      const hasBranch = scopeIncludes(scopeStart, scopeEnd, 'branch');
      const hasStaged = scopeIncludes(scopeStart, scopeEnd, 'staged');
      const hasUnstaged = scopeIncludes(scopeStart, scopeEnd, 'unstaged');
      const hasUntracked = scopeIncludes(scopeStart, scopeEnd, 'untracked');

      if (hasBranch && baseBranch) {
        const mergeBase = await findMergeBase(cwd, baseBranch);
        commands.push(
          execPromise(`git diff ${GIT_DIFF_FLAGS} ${mergeBase}..HEAD --name-only`, { cwd }).then(r => r.stdout)
        );
      }
      if (hasStaged) {
        commands.push(
          execPromise(`git diff ${GIT_DIFF_FLAGS} --cached --name-only`, { cwd }).then(r => r.stdout)
        );
      }
      if (hasUnstaged) {
        commands.push(
          execPromise(`git diff ${GIT_DIFF_FLAGS} --name-only`, { cwd }).then(r => r.stdout)
        );
      }
      if (hasUntracked) {
        commands.push(
          execPromise('git ls-files --others --exclude-standard', { cwd }).then(r => r.stdout)
        );
      }
    } else {
      // Fallback: no scope info — include unstaged + untracked + staged
      commands.push(
        execPromise(`git diff ${GIT_DIFF_FLAGS} --name-only`, { cwd }).then(r => r.stdout),
        execPromise('git ls-files --others --exclude-standard', { cwd }).then(r => r.stdout),
        execPromise(`git diff ${GIT_DIFF_FLAGS} --cached --name-only`, { cwd }).then(r => r.stdout)
      );
    }

    const results = await Promise.all(commands);
    const all = results
      .flatMap(output => output.trim().split('\n'))
      .filter(f => f.length > 0);
    return [...new Set(all)];
  } catch (error) {
    logger.warn(`Could not get changed files list: ${error.message}`);
    return [];
  }
}

/**
 * Validate suggestions: filter by file path and clamp invalid line numbers.
 * Mirrors Analyzer.validateAndFinalizeSuggestions as a standalone function.
 * @param {Array} suggestions - Suggestion objects from the executable provider
 * @param {string[]} validFiles - Changed file paths from the diff
 * @param {Map<string, number>} fileLineCountMap - File path → line count
 * @returns {Array} Validated suggestions
 */
function validateSuggestions(suggestions, validFiles, fileLineCountMap) {
  if (!suggestions || suggestions.length === 0) return [];
  const inputCount = suggestions.length;

  // File path validation
  let filtered = suggestions;
  if (validFiles && validFiles.length > 0) {
    const normalizedValid = new Set(validFiles.map(p => normalizePath(resolveRenamedFile(p))));
    filtered = suggestions.filter(s => {
      const norm = normalizePath(resolveRenamedFile(s.file));
      if (normalizedValid.has(norm)) return true;
      logger.warn(`[Validation] Discarded suggestion with invalid path: "${s.file}" (${s.type} - ${s.title})`);
      return false;
    });
    if (filtered.length < inputCount) {
      logger.info(`[Validation] File path filter: ${inputCount} → ${filtered.length} suggestions`);
    }
  } else {
    logger.warn('[Validation] No valid paths available, skipping path filtering');
  }

  // Line number validation
  const lineResult = validateSuggestionLineNumbers(filtered, fileLineCountMap, { convertToFileLevel: true });
  if (lineResult.converted.length > 0) {
    logger.warn(`[Validation] Converted ${lineResult.converted.length} suggestions to file-level (invalid line numbers)`);
  }

  const final = [...lineResult.valid, ...lineResult.converted];
  logger.info(`[Validation] Final: ${final.length} suggestions from ${inputCount} input`);
  return final;
}

/**
 * Run the full executable-provider analysis lifecycle.
 *
 * @param {object}   req              Express request (used for app-level refs)
 * @param {object}   res              Express response (JSON reply sent early)
 * @param {object}   params           Common parameters
 * @param {string}   params.reviewId
 * @param {object}   params.review
 * @param {string}   params.selectedProvider
 * @param {string}   params.selectedModel
 * @param {string|null} params.repoInstructions
 * @param {string|null} params.requestInstructions
 * @param {string}   params.runId
 * @param {string}   params.analysisId
 * @param {string}   params.repository
 * @param {string}   params.reviewType   'local' | 'pr'
 * @param {string}   params.headSha      SHA to record on the analysis run
 * @param {object}   [params.extraInitialStatus]  Extra fields merged into the initial progress status
 * @param {object}   shared            Shared state / helpers from the route module
 * @param {Map}      shared.activeAnalyses
 * @param {Map}      shared.reviewToAnalysisId
 * @param {Function} shared.broadcastProgress
 * @param {Function} shared.broadcastReviewEvent
 * @param {Function} shared.registerProcessForCancellation
 * @param {object}   callbacks         Mode-specific behaviour
 * @param {Function} callbacks.buildContext      (review, { selectedModel, requestInstructions }) => executableContext object
 * @param {Function} callbacks.buildHookPayload  (review, extra) => object merged into hook payload
 * @param {Function} callbacks.onSuccess         (db, runId, { suggestions, summary }) => Promise
 * @param {string}   callbacks.logLabel          e.g. "Review #5" or "PR #42"
 */
async function runExecutableAnalysis(req, res, params, shared, callbacks) {
  const {
    reviewId, review, selectedProvider, selectedModel,
    repoInstructions, requestInstructions,
    runId, analysisId, repository, reviewType, headSha,
    extraInitialStatus
  } = params;

  const {
    activeAnalyses, reviewToAnalysisId,
    broadcastProgress, broadcastReviewEvent,
    registerProcessForCancellation
  } = shared;

  const { buildContext, buildHookPayload, onSuccess, logLabel } = callbacks;

  const db = req.app.get('db');
  const analysisRunRepo = new AnalysisRunRepository(db);
  const commentRepo = new CommentRepository(db);

  // 1. Create analysis run record
  try {
    await analysisRunRepo.create({
      id: runId,
      reviewId,
      provider: selectedProvider,
      model: selectedModel,
      tier: 'thorough',
      repoInstructions,
      requestInstructions,
      headSha: headSha || null,
      configType: 'single',
      levelsConfig: null
    });
  } catch (error) {
    logger.error('Failed to create analysis run record:', error);
    return res.status(500).json({ error: 'Failed to initialize analysis tracking' });
  }

  // 2. Set up progress tracking
  const initialStatus = {
    id: analysisId,
    runId,
    reviewId,
    ...extraInitialStatus,
    repository,
    reviewType,
    status: 'running',
    // TODO: derive from provider capabilities once level-based progress is supported for executable providers
    noLevels: true,
    startedAt: new Date().toISOString(),
    progress: 'Running external analysis tool...',
    levels: {},
    filesAnalyzed: 0,
    filesRemaining: 0
  };
  activeAnalyses.set(analysisId, initialStatus);
  reviewToAnalysisId.set(reviewId, analysisId);

  broadcastProgress(analysisId, initialStatus);
  broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });

  // 3. Fire analysis.started hook
  const analysisHookConfig = req.app.get('config') || {};
  const hookPayloadFields = buildHookPayload(review, {});
  if (hasHooks('analysis.started', analysisHookConfig)) {
    getCachedUser(analysisHookConfig).then(user => {
      fireHooks('analysis.started', buildAnalysisStartedPayload({
        reviewId, analysisId, provider: selectedProvider, model: selectedModel,
        ...hookPayloadFields,
        user,
      }), analysisHookConfig);
    }).catch(() => {});
  }

  // 4. Respond immediately — analysis runs async
  res.json({
    analysisId,
    runId,
    status: 'running',
    message: 'Executable provider analysis started'
  });

  // 5. Run the executable provider asynchronously
  (async () => {
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pair-review-exec-'));
    try {
      const provider = createProvider(selectedProvider, selectedModel);

      const executableContext = {
        ...buildContext(review, { selectedModel, requestInstructions }),
        outputDir: tmpDir,
        // Use resolved CLI model (cli_model || id) instead of raw model ID; null suppresses model
        model: provider.resolvedModel !== undefined ? provider.resolvedModel : (provider.model || null)
      };
      const cwd = executableContext.cwd || process.cwd();

      // Only generate a diff file when the provider's context_args maps diff_path to a CLI flag
      if (provider.contextArgs?.diff_path) {
        const diffPath = path.join(tmpDir, 'review.diff');
        try {
          await generateDiffForExecutable(cwd, executableContext, provider.diffArgs || [], diffPath);
          executableContext.diffPath = diffPath;
        } catch (diffError) {
          logger.warn(`Failed to generate diff for executable: ${diffError.message} — continuing without diff`);
        }
      }

      logger.section(`Executable Provider Analysis - ${logLabel}`);
      logger.log('API', `Provider: ${selectedProvider}`, 'cyan');
      logger.log('API', `Model: ${selectedModel}`, 'cyan');
      logger.log('API', `Working dir: ${cwd}`, 'magenta');
      logger.log('API', `Output dir: ${tmpDir}`, 'magenta');
      if (executableContext.diffPath) {
        logger.log('API', `Diff file: ${executableContext.diffPath}`, 'magenta');
      }

      // Throttled stream event handler — avoids flooding WebSocket
      let lastBroadcastTime = 0;
      const THROTTLE_MS = 300;
      const onStreamEvent = (event) => {
        const status = activeAnalyses.get(analysisId);
        if (!status) return;
        status.levels = { exec: { status: 'running', streamEvent: event } };
        const now = Date.now();
        if (now - lastBroadcastTime >= THROTTLE_MS) {
          lastBroadcastTime = now;
          broadcastProgress(analysisId, status);
        }
      };

      const result = await provider.execute(null, {
        executableContext,
        cwd,
        timeout: provider.timeout || 600000,
        analysisId,
        registerProcess: (id, proc) => registerProcessForCancellation(id, proc),
        onStreamEvent
      });

      if (!result?.success || !result?.data) {
        throw new Error('Executable provider returned no data');
      }

      const rawSuggestions = result.data.suggestions || [];
      const summary = result.data.summary || '';

      // Validate suggestions against the diff (file paths + line numbers)
      const validFiles = await getChangedFiles(cwd, executableContext);
      const fileLineCountMap = validFiles.length > 0
        ? await buildFileLineCountMap(cwd, validFiles)
        : new Map();
      const suggestions = validateSuggestions(rawSuggestions, validFiles, fileLineCountMap);

      // Store validated suggestions
      await commentRepo.bulkInsertAISuggestions(reviewId, runId, suggestions, null);

      // Update run to completed
      await analysisRunRepo.update(runId, {
        status: 'completed',
        summary,
        totalSuggestions: suggestions.length,
        completedAt: new Date().toISOString()
      });

      // Mode-specific success handling
      await onSuccess(db, runId, { suggestions, summary });

      logger.success(`Executable analysis complete for ${logLabel}: ${suggestions.length} suggestions`);

      // Update progress tracking
      const completedStatus = {
        ...activeAnalyses.get(analysisId),
        status: 'completed',
        completedAt: new Date().toISOString(),
        progress: `Analysis complete: ${suggestions.length} suggestions found`,
        suggestionsCount: suggestions.length
      };
      activeAnalyses.set(analysisId, completedStatus);
      broadcastProgress(analysisId, completedStatus);
      broadcastReviewEvent(reviewId, { type: 'review:analysis_completed' });

      // Fire analysis.completed hook
      if (hasHooks('analysis.completed', analysisHookConfig)) {
        getCachedUser(analysisHookConfig).then(user => {
          fireHooks('analysis.completed', buildAnalysisCompletedPayload({
            reviewId, analysisId, provider: selectedProvider, model: selectedModel,
            status: 'success', totalSuggestions: suggestions.length,
            ...hookPayloadFields,
            user,
          }), analysisHookConfig);
        }).catch(() => {});
      }
    } catch (error) {
      if (error.isCancellation) {
        logger.info(`Executable analysis cancelled for ${logLabel}`);
        // Status is already set to 'cancelled' by the cancel endpoint
        if (hasHooks('analysis.completed', analysisHookConfig)) {
          getCachedUser(analysisHookConfig).then(user => {
            fireHooks('analysis.completed', buildAnalysisCompletedPayload({
              reviewId, analysisId, provider: selectedProvider, model: selectedModel,
              status: 'cancelled', totalSuggestions: 0,
              ...hookPayloadFields,
              user,
            }), analysisHookConfig);
          }).catch(() => {});
        }
        return;
      }

      logger.error(`Executable analysis failed for ${logLabel}: ${error.message}`);

      // Update run to failed
      try {
        await analysisRunRepo.update(runId, {
          status: 'failed',
          completedAt: new Date().toISOString()
        });
      } catch (e) {
        logger.warn(`Failed to update run status: ${e.message}`);
      }

      const failedStatus = {
        ...activeAnalyses.get(analysisId),
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message,
        progress: 'Analysis failed'
      };
      activeAnalyses.set(analysisId, failedStatus);
      broadcastProgress(analysisId, failedStatus);

      if (hasHooks('analysis.completed', analysisHookConfig)) {
        getCachedUser(analysisHookConfig).then(user => {
          fireHooks('analysis.completed', buildAnalysisCompletedPayload({
            reviewId, analysisId, provider: selectedProvider, model: selectedModel,
            status: 'failed', totalSuggestions: 0,
            ...hookPayloadFields,
            user,
          }), analysisHookConfig);
        }).catch(() => {});
      }
    } finally {
      // Clean up review-to-analysis mapping (allow new analyses for this review).
      // Do NOT delete activeAnalyses entry — leave it with terminal status so
      // clients can poll for final results via HTTP (matches local.js/pr.js).
      reviewToAnalysisId.delete(reviewId);

      // Clean up temp directory (keep in debug mode for inspection)
      if (tmpDir) {
        if (logger.isStreamDebugEnabled()) {
          logger.info(`Keeping executable output dir for debug: ${tmpDir}`);
        } else {
          try {
            await fsPromises.rm(tmpDir, { recursive: true, force: true });
          } catch (e) {
            logger.debug(`Failed to clean up temp dir ${tmpDir}: ${e.message}`);
          }
        }
      }
    }
  })();
}

module.exports = { runExecutableAnalysis, generateDiffForExecutable, getChangedFiles };
