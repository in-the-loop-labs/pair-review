// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AI Analysis Routes (shared, ID-based endpoints)
 *
 * Provides endpoints that work across both PR mode and Local mode:
 * - GET  /api/analyses/runs              — list analysis runs for a review
 * - GET  /api/analyses/runs/latest       — get most recent run for a review
 * - GET  /api/analyses/runs/:runId       — get a specific run
 * - POST /api/analyses/results           — import external analysis results
 * - GET  /api/analyses/:id/status        — get in-memory analysis status
 * - POST /api/analyses/:id/cancel        — cancel an active analysis
 *
 * Routes that are PR-specific or local-specific live in pr.js and local.js
 * respectively (e.g., starting an analysis).
 */

const express = require('express');
const { queryOne, withTransaction, ReviewRepository, CommentRepository, AnalysisRunRepository, CouncilRepository } = require('../database');
const Analyzer = require('../ai/analyzer');
const { getTierForModel } = require('../ai/provider');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { broadcastReviewEvent } = require('../sse/review-events');
const path = require('path');
const { normalizeRepository } = require('../utils/paths');
const {
  activeAnalyses,
  reviewToAnalysisId,
  localReviewDiffs,
  broadcastProgress,
  killProcesses,
  createProgressCallback
} = require('./shared');
const { generateLocalDiff, computeLocalDiffDigest } = require('../local-review');
const { validateCouncilConfig, normalizeCouncilConfig } = require('./councils');
const { TIERS, TIER_ALIASES, VALID_TIERS, resolveTier } = require('../ai/prompts/config');

const router = express.Router();

/**
 * Enrich a raw analysis run record for API responses.
 * Applies backward-compatible tier fallback and parses levels_config JSON.
 */
function enrichRun(run) {
  if (!run) return null;
  return {
    ...run,
    levels_config: run.levels_config ? JSON.parse(run.levels_config) : null,
    tier: run.tier ?? (run.provider && run.model ? getTierForModel(run.provider, run.model) : null)
  };
}

// ==========================================================================
// Static path routes — registered BEFORE :id param routes to avoid clashes
// ==========================================================================

/**
 * Get all analysis runs for a review
 * Query param: reviewId (integer)
 */
router.get('/api/analyses/runs', async (req, res) => {
  try {
    const reviewId = parseInt(req.query.reviewId, 10);

    if (!reviewId || isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Missing or invalid reviewId query parameter' });
    }

    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const runs = await analysisRunRepo.getByReviewId(reviewId);

    res.json({ runs: runs.map(enrichRun) });
  } catch (error) {
    logger.error('Error fetching analysis runs:', error);
    res.status(500).json({ error: 'Failed to fetch analysis runs' });
  }
});

/**
 * Get the most recent analysis run for a review
 * Query param: reviewId (integer)
 */
router.get('/api/analyses/runs/latest', async (req, res) => {
  try {
    const reviewId = parseInt(req.query.reviewId, 10);

    if (!reviewId || isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Missing or invalid reviewId query parameter' });
    }

    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const run = await analysisRunRepo.getLatestByReviewId(reviewId);

    if (!run) {
      return res.status(404).json({ error: 'No analysis runs found' });
    }

    res.json({ run: enrichRun(run) });
  } catch (error) {
    logger.error('Error fetching latest analysis run:', error);
    res.status(500).json({ error: 'Failed to fetch latest analysis run' });
  }
});

/**
 * Get a specific analysis run by ID
 */
router.get('/api/analyses/runs/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const db = req.app.get('db');

    const analysisRunRepo = new AnalysisRunRepository(db);
    const run = await analysisRunRepo.getById(runId);

    if (!run) {
      return res.status(404).json({ error: 'Analysis run not found' });
    }

    res.json({ run: enrichRun(run) });
  } catch (error) {
    logger.error('Error fetching analysis run:', error);
    res.status(500).json({ error: 'Failed to fetch analysis run' });
  }
});

/**
 * Import externally-produced analysis results
 *
 * Accepts suggestions generated outside pair-review (e.g. by a coding agent's
 * analyze skill) and stores them as a completed analysis run so they appear
 * inline in the web UI.
 */
router.post('/api/analyses/results', async (req, res) => {
  try {
    const {
      path: localPath,
      headSha,
      repo,
      prNumber,
      provider = null,
      model = null,
      summary = null,
      suggestions = [],
      fileLevelSuggestions = [],
      tier = null
    } = req.body || {};

    // --- Validate tier ---
    let resolvedTier = tier;
    if (tier != null) {
      if (!VALID_TIERS.includes(tier)) {
        return res.status(400).json({
          error: `Invalid tier: "${tier}". Valid tiers: ${VALID_TIERS.join(', ')}`
        });
      }
      resolvedTier = resolveTier(tier);
    }

    // --- Validate identification pair ---
    const hasLocal = localPath && headSha;
    const hasPR = repo && prNumber != null;

    if (!hasLocal && !hasPR) {
      return res.status(400).json({
        error: 'Must provide either (path + headSha) for local mode or (repo + prNumber) for PR mode'
      });
    }
    if (hasLocal && hasPR) {
      return res.status(400).json({
        error: 'Provide only one identification pair: (path + headSha) or (repo + prNumber), not both'
      });
    }

    // --- Validate suggestions ---
    if (!Array.isArray(suggestions)) {
      return res.status(400).json({ error: 'suggestions must be an array' });
    }
    if (!Array.isArray(fileLevelSuggestions)) {
      return res.status(400).json({ error: 'fileLevelSuggestions must be an array' });
    }

    const REQUIRED_SUGGESTION_FIELDS = ['file', 'type', 'title', 'description'];
    for (const [idx, s] of suggestions.entries()) {
      for (const field of REQUIRED_SUGGESTION_FIELDS) {
        if (!s[field]) {
          return res.status(400).json({
            error: `suggestions[${idx}] missing required field: ${field}`
          });
        }
      }
    }
    for (const [idx, s] of fileLevelSuggestions.entries()) {
      for (const field of REQUIRED_SUGGESTION_FIELDS) {
        if (!s[field]) {
          return res.status(400).json({
            error: `fileLevelSuggestions[${idx}] missing required field: ${field}`
          });
        }
      }
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const analysisRunRepo = new AnalysisRunRepository(db);

    // --- Resolve review ---
    let reviewId;
    if (hasLocal) {
      // Local mode: derive repository name from the directory basename
      const repository = path.basename(localPath) || 'local';
      reviewId = await reviewRepo.upsertLocalReview({
        localPath,
        localHeadSha: headSha,
        repository
      });

      // Generate and store diff so the web UI can display it
      try {
        const diffResult = await generateLocalDiff(localPath);
        const digest = await computeLocalDiffDigest(localPath);
        localReviewDiffs.set(reviewId, { diff: diffResult.diff, stats: diffResult.stats, digest });
      } catch (diffError) {
        logger.warn(`Could not generate diff for local review ${reviewId}: ${diffError.message}`);
      }
    } else {
      const repoParts = repo.split('/');
      if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        return res.status(400).json({ error: 'repo must be in format owner/repo' });
      }
      const parsedPR = parseInt(prNumber, 10);
      if (isNaN(parsedPR) || parsedPR <= 0) {
        return res.status(400).json({ error: 'Invalid pull request number' });
      }
      const repository = normalizeRepository(repoParts[0], repoParts[1]);
      const review = await reviewRepo.getOrCreate({
        prNumber: parsedPR,
        repository
      });
      reviewId = review.id;
    }

    // --- Create completed analysis run, insert suggestions, update stats ---
    const runId = uuidv4();
    const allSuggestions = [
      ...suggestions.map(s => ({ ...s, is_file_level: false })),
      ...fileLevelSuggestions.map(s => ({ ...s, is_file_level: true }))
    ];
    const totalSuggestions = allSuggestions.length;
    const filesAnalyzed = new Set(allSuggestions.map(s => s.file)).size;

    const commentRepo = new CommentRepository(db);

    await withTransaction(db, async () => {
      await analysisRunRepo.create({
        id: runId,
        reviewId,
        provider,
        model,
        tier: resolvedTier,
        headSha: headSha || null,
        status: 'completed'
      });

      await commentRepo.bulkInsertAISuggestions(reviewId, runId, allSuggestions);

      await analysisRunRepo.update(runId, {
        summary,
        totalSuggestions,
        filesAnalyzed
      });
    });

    // --- Broadcast completion event via WebSocket (after transaction completes) ---
    const completionEvent = {
      id: runId,
      status: 'completed',
      completedAt: new Date().toISOString(),
      progress: `Analysis complete — ${totalSuggestions} suggestion${totalSuggestions !== 1 ? 's' : ''}`,
      suggestionsCount: totalSuggestions,
      filesAnalyzed,
      levels: {
        1: { status: 'completed', progress: 'Complete' },
        2: { status: 'completed', progress: 'Complete' },
        3: { status: 'completed', progress: 'Complete' },
        4: { status: 'completed', progress: 'Complete' }
      }
    };
    broadcastProgress(runId, completionEvent);

    broadcastReviewEvent(reviewId, { type: 'review:analysis_completed' });

    logger.success(`Imported ${totalSuggestions} external analysis suggestions (run ${runId})`);

    res.status(201).json({
      runId,
      reviewId,
      totalSuggestions,
      status: 'completed'
    });
  } catch (error) {
    logger.error('Error importing analysis results:', error);
    res.status(500).json({ error: 'Failed to import analysis results' });
  }
});

// ==========================================================================
// Parameterised :id routes — registered AFTER static paths
// ==========================================================================

/**
 * Get AI analysis status
 */
router.get('/api/analyses/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    const analysis = activeAnalyses.get(id);

    if (!analysis) {
      return res.status(404).json({
        error: 'Analysis not found'
      });
    }

    res.json(analysis);

  } catch (error) {
    logger.error('Error fetching analysis status:', error);
    res.status(500).json({
      error: 'Failed to fetch analysis status'
    });
  }
});

/**
 * Cancel an active AI analysis
 */
router.post('/api/analyses/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;

    const analysis = activeAnalyses.get(id);

    if (!analysis) {
      return res.status(404).json({
        error: 'Analysis not found'
      });
    }

    // Check if already completed/failed/cancelled
    if (['completed', 'failed', 'cancelled'].includes(analysis.status)) {
      return res.json({
        success: true,
        message: `Analysis already ${analysis.status}`,
        status: analysis.status
      });
    }

    logger.section(`Cancelling Analysis: ${id}`);
    // Log context based on review type (PR mode vs local mode)
    if (analysis.reviewType === 'local') {
      logger.log('API', `Local review #${analysis.reviewId} in ${analysis.repository}`, 'yellow');
    } else {
      logger.log('API', `PR #${analysis.prNumber} in ${analysis.repository}`, 'yellow');
    }

    // Kill all running child processes for this analysis
    const killedCount = killProcesses(id);
    logger.info(`Killed ${killedCount} running process(es)`);

    // Update database record to cancelled
    if (analysis.runId) {
      try {
        const db = req.app.get('db');
        const analysisRunRepo = new AnalysisRunRepository(db);
        await analysisRunRepo.update(analysis.runId, { status: 'cancelled' });
        logger.info(`Updated analysis_run DB record to cancelled: ${analysis.runId}`);
      } catch (dbError) {
        logger.warn(`Failed to update analysis_run DB record: ${dbError.message}`);
      }
    }

    // Update analysis status to cancelled
    const cancelledStatus = {
      ...analysis,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      progress: 'Analysis cancelled by user',
      levels: {
        ...analysis.levels,
        1: analysis.levels?.[1]?.status === 'running'
          ? { status: 'cancelled', progress: 'Cancelled' }
          : analysis.levels?.[1],
        2: analysis.levels?.[2]?.status === 'running'
          ? { status: 'cancelled', progress: 'Cancelled' }
          : analysis.levels?.[2],
        3: analysis.levels?.[3]?.status === 'running'
          ? { status: 'cancelled', progress: 'Cancelled' }
          : analysis.levels?.[3],
        4: analysis.levels?.[4]?.status === 'running'
          ? { status: 'cancelled', progress: 'Cancelled' }
          : analysis.levels?.[4]
      }
    };

    activeAnalyses.set(id, cancelledStatus);

    // Broadcast cancelled status to WebSocket clients
    broadcastProgress(id, cancelledStatus);

    // Clean up review to analysis ID mapping
    if (analysis.reviewId) {
      reviewToAnalysisId.delete(analysis.reviewId);
    }

    logger.success(`Analysis ${id} cancelled successfully`);

    res.json({
      success: true,
      message: 'Analysis cancelled',
      processesKilled: killedCount,
      status: 'cancelled'
    });

  } catch (error) {
    logger.error(`Error cancelling analysis: ${error.message}`);
    res.status(500).json({
      error: 'Failed to cancel analysis'
    });
  }
});

// ==========================================================================
// Shared helper: launch council analysis
// ==========================================================================

/**
 * Launch a council analysis, shared by both PR and local mode.
 *
 * This helper encapsulates all the common logic: council config resolution/validation,
 * analysis run record creation, progress tracking setup, async analyzer invocation,
 * completion/failure status broadcasting, and tracking map cleanup.
 *
 * @param {Object} db - Database handle
 * @param {Object} modeContext - Mode-specific values
 * @param {Object} councilConfig - Validated council configuration
 * @param {string} councilId - Council ID (for the model field in analysis_runs), or null for inline config
 * @param {Object} instructions - { repoInstructions, requestInstructions }
 * @param {string} [configType='advanced'] - Config type
 * @returns {{ analysisId: string, runId: string }}
 */
function isLevelEnabled(councilConfig, levelKey) {
  const val = councilConfig.levels?.[levelKey];
  if (typeof val === 'boolean') return val;
  return val?.enabled === true;
}

async function launchCouncilAnalysis(db, modeContext, councilConfig, councilId, instructions, configType = 'advanced') {
  const {
    reviewId,
    worktreePath,
    prMetadata,
    changedFiles,
    repository,
    headSha,
    logLabel,
    initialStatusExtra,
    onSuccess,
    runUpdateExtra
  } = modeContext;

  const { repoInstructions, requestInstructions } = instructions;

  const isVoiceCentric = configType === 'council';

  const runId = uuidv4();
  const analysisId = runId;

  let levelsConfig = null;
  if (isVoiceCentric && councilConfig.levels) {
    levelsConfig = councilConfig.levels;
  } else if (councilConfig.levels) {
    levelsConfig = {};
    for (const [key, val] of Object.entries(councilConfig.levels)) {
      levelsConfig[key] = val?.enabled !== false;
    }
  }

  const analysisRunRepo = new AnalysisRunRepository(db);
  await analysisRunRepo.create({
    id: runId,
    reviewId,
    provider: 'council',
    model: councilId || 'inline-config',
    tier: null,
    repoInstructions,
    requestInstructions,
    headSha: headSha || null,
    configType,
    levelsConfig
  });

  if (councilId) {
    const councilRepo = new CouncilRepository(db);
    councilRepo.touchLastUsedAt(councilId).catch(err => {
      logger.warn(`Failed to update council last_used_at: ${err.message}`);
    });
  }

  const initialStatus = {
    id: analysisId,
    reviewId,
    repository,
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: 'Starting council analysis...',
    levels: {
      1: isLevelEnabled(councilConfig, '1') ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
      2: isLevelEnabled(councilConfig, '2') ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
      3: isLevelEnabled(councilConfig, '3') ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
      4: { status: 'pending', progress: 'Pending' }
    },
    isCouncil: true,
    councilConfig,
    configType,
    filesAnalyzed: 0,
    filesRemaining: 0,
    ...initialStatusExtra
  };
  activeAnalyses.set(analysisId, initialStatus);

  // Store unified tracking map entry (integer reviewId -> analysis UUID)
  reviewToAnalysisId.set(reviewId, analysisId);

  broadcastProgress(analysisId, initialStatus);
  broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });

  const analyzer = new Analyzer(db, 'council', 'council');

  logger.section(`Council Analysis Request (${configType}) - ${logLabel}`);
  logger.log('API', `Repository: ${repository}`, 'magenta');
  logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
  logger.log('API', `Config type: ${configType}`, 'magenta');

  const progressCallback = createProgressCallback(analysisId);

  const reviewContext = {
    reviewId,
    worktreePath,
    prMetadata,
    changedFiles,
    instructions: { repoInstructions, requestInstructions }
  };

  const analysisPromise = isVoiceCentric
    ? analyzer.runReviewerCentricCouncil(reviewContext, councilConfig, { analysisId, runId, progressCallback })
    : analyzer.runCouncilAnalysis(reviewContext, councilConfig, { analysisId, runId, progressCallback });

  analysisPromise
    .then(async result => {
      logger.success(`Council analysis complete for ${logLabel}: ${result.suggestions.length} suggestions`);

      try {
        await analysisRunRepo.update(runId, {
          status: 'completed',
          summary: result.summary,
          totalSuggestions: result.suggestions.length,
          ...runUpdateExtra
        });
      } catch (updateError) {
        logger.warn(`Failed to update analysis_run: ${updateError.message}`);
      }

      if (onSuccess) {
        try {
          await onSuccess(result, analysisRunRepo, runId);
        } catch (callbackError) {
          logger.warn(`Council onSuccess callback failed: ${callbackError.message}`);
        }
      }

      const currentStatus = activeAnalyses.get(analysisId);
      if (!currentStatus) return;

      const completedStatus = {
        ...currentStatus,
        status: 'completed',
        completedAt: new Date().toISOString(),
        progress: `Council analysis complete — ${result.suggestions.length} suggestions`,
        suggestionsCount: result.suggestions.length,
        levels: {
          ...currentStatus.levels,
          4: { status: 'completed', progress: 'Results finalized' }
        }
      };
      for (const levelKey of ['1', '2', '3']) {
        if (currentStatus.levels?.[levelKey]?.status === 'running') {
          completedStatus.levels[levelKey] = { status: 'completed', progress: 'Complete' };
        }
      }
      activeAnalyses.set(analysisId, completedStatus);
      broadcastProgress(analysisId, completedStatus);
      broadcastReviewEvent(initialStatus.reviewId, { type: 'review:analysis_completed' });
    })
    .catch(error => {
      if (error.isCancellation) {
        logger.info(`Council analysis cancelled for ${logLabel}`);
        return;
      }
      logger.error(`Council analysis failed for ${logLabel}: ${error.message}`);

      const failedStatus = {
        ...(activeAnalyses.get(analysisId) || {}),
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message,
        progress: 'Council analysis failed'
      };
      activeAnalyses.set(analysisId, failedStatus);
      broadcastProgress(analysisId, failedStatus);

      analysisRunRepo.update(runId, { status: 'failed' }).catch(() => {});
    })
    .finally(() => {
      // Clean up unified tracking map entry
      reviewToAnalysisId.delete(reviewId);
    });

  return { analysisId, runId };
}

// Export the helper for pr.js and local.js to use
router.launchCouncilAnalysis = launchCouncilAnalysis;

module.exports = router;
