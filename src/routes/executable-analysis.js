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
const fsPromises = require('fs').promises;
const logger = require('../utils/logger');
const { createProvider } = require('../ai/provider');
const { AnalysisRunRepository, CommentRepository } = require('../database');
const { fireHooks, hasHooks } = require('../hooks/hook-runner');
const { buildAnalysisStartedPayload, buildAnalysisCompletedPayload, getCachedUser } = require('../hooks/payloads');

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
        outputDir: tmpDir
      };
      const cwd = executableContext.cwd || process.cwd();

      logger.section(`Executable Provider Analysis - ${logLabel}`);
      logger.log('API', `Provider: ${selectedProvider}`, 'cyan');
      logger.log('API', `Model: ${selectedModel}`, 'cyan');
      logger.log('API', `Working dir: ${cwd}`, 'magenta');
      logger.log('API', `Output dir: ${tmpDir}`, 'magenta');

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

      const suggestions = result.data.suggestions || [];
      const summary = result.data.summary || '';

      // Store suggestions
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
      // Clean up tracking maps
      activeAnalyses.delete(analysisId);
      reviewToAnalysisId.delete(reviewId);

      // Clean up temp directory
      if (tmpDir) {
        try {
          await fsPromises.rm(tmpDir, { recursive: true, force: true });
        } catch (e) {
          logger.debug(`Failed to clean up temp dir ${tmpDir}: ${e.message}`);
        }
      }
    }
  })();
}

module.exports = { runExecutableAnalysis };
