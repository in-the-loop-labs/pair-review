/**
 * AI Analysis Routes
 *
 * Handles all AI analysis-related endpoints:
 * - Triggering analysis (Level 1, 2, 3)
 * - Getting analysis status
 * - Checking for AI suggestions
 * - Fetching AI suggestions
 * - SSE progress streaming
 */

const express = require('express');
const { query, queryOne, run, withTransaction, RepoSettingsRepository, ReviewRepository, AnalysisRunRepository } = require('../database');
const { GitWorktreeManager } = require('../git/worktree');
const Analyzer = require('../ai/analyzer');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { mergeInstructions } = require('../utils/instructions');
const { calculateStats, getStatsQuery } = require('../utils/stats-calculator');
const {
  activeAnalyses,
  prToAnalysisId,
  progressClients,
  getPRKey,
  getModel,
  determineCompletionInfo,
  broadcastProgress,
  killProcesses,
  isAnalysisCancelled,
  CancellationError
} = require('./shared');

const router = express.Router();

/**
 * Trigger AI analysis for a PR (Level 1)
 */
router.post('/api/analyze/:owner/:repo/:pr', async (req, res) => {
  try {
    const { owner, repo, pr } = req.params;
    const prNumber = parseInt(pr);

    // Extract optional provider, model and customInstructions from request body
    const { provider: requestProvider, model: requestModel, customInstructions: rawInstructions } = req.body || {};

    // Trim and validate custom instructions
    const MAX_INSTRUCTIONS_LENGTH = 5000;
    let requestInstructions = rawInstructions?.trim() || null;
    if (requestInstructions && requestInstructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return res.status(400).json({
        error: `Custom instructions exceed maximum length of ${MAX_INSTRUCTIONS_LENGTH} characters`
      });
    }

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Check if PR exists in database
    const db = req.app.get('db');
    // Create ReviewRepository once for reuse throughout the handler
    const reviewRepo = new ReviewRepository(db);
    const prMetadata = await queryOne(db, `
      SELECT id, base_branch, title, description, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    // Parse pr_data to get base_sha and head_sha
    let prData = {};
    try {
      prData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Merge parsed data into prMetadata for use in analysis
    prMetadata.base_sha = prData.base_sha;
    prMetadata.head_sha = prData.head_sha;

    // Get worktree path
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    // Fetch repo settings and save custom instructions in a transaction
    // This ensures consistency between reading settings and updating the review record
    const { provider, model, combinedInstructions } = await withTransaction(db, async () => {
      // Fetch repo settings for default instructions, provider, and model
      const repoSettingsRepo = new RepoSettingsRepository(db);
      const fetchedRepoSettings = await repoSettingsRepo.getRepoSettings(repository);

      // Determine provider: request body > repo settings > config > default ('claude')
      let selectedProvider;
      if (requestProvider) {
        selectedProvider = requestProvider;
      } else if (fetchedRepoSettings && fetchedRepoSettings.default_provider) {
        selectedProvider = fetchedRepoSettings.default_provider;
      } else {
        const config = req.app.get('config') || {};
        selectedProvider = config.provider || 'claude';
      }

      // Determine model: request body > repo settings > config/CLI > default
      let selectedModel;
      if (requestModel) {
        selectedModel = requestModel;
      } else if (fetchedRepoSettings && fetchedRepoSettings.default_model) {
        selectedModel = fetchedRepoSettings.default_model;
      } else {
        selectedModel = getModel(req);
      }

      // Merge custom instructions using shared utility
      const repoInstructions = fetchedRepoSettings?.default_instructions;
      const mergedInstructions = mergeInstructions(repoInstructions, requestInstructions);

      // Save custom instructions to the review record using upsert
      // Uses reviewRepo created at the start of the handler
      if (requestInstructions) {
        await reviewRepo.upsertCustomInstructions(prNumber, repository, requestInstructions);
      }

      return {
        provider: selectedProvider,
        model: selectedModel,
        combinedInstructions: mergedInstructions
      };
    });

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status with separate tracking for each level
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: 'Starting analysis...',
      // Track each level separately for parallel execution
      levels: {
        1: { status: 'running', progress: 'Starting...' },
        2: { status: 'running', progress: 'Starting...' },
        3: { status: 'running', progress: 'Starting...' },
        4: { status: 'pending', progress: 'Pending' }
      },
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store PR to analysis ID mapping
    const prKey = getPRKey(owner, repo, prNumber);
    prToAnalysisId.set(prKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Get or create a review record for this PR
    // The review.id is passed to the analyzer so comments use review.id, not prMetadata.id
    // This avoids ID collision with local mode where comments also use reviews.id
    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    // Create analyzer instance with provider and model
    const analyzer = new Analyzer(req.app.get('db'), model, provider);

    // Log analysis start with colorful output
    logger.section(`AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Worktree: ${worktreePath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Review ID: ${review.id}`, 'magenta');
    logger.log('API', `Provider: ${provider}`, 'cyan');
    logger.log('API', `Model: ${model}`, 'cyan');
    if (combinedInstructions) {
      logger.log('API', `Custom instructions: ${combinedInstructions.length} chars`, 'cyan');
    }

    // Create progress callback function that tracks each level separately
    const progressCallback = (progressUpdate) => {
      const currentStatus = activeAnalyses.get(analysisId);
      if (!currentStatus) return;

      const level = progressUpdate.level;

      // Update the specific level's status
      if (level && level >= 1 && level <= 3) {
        currentStatus.levels[level] = {
          status: progressUpdate.status || 'running',
          progress: progressUpdate.progress || 'In progress...'
        };
      }

      // Handle orchestration as level 4
      if (level === 'orchestration') {
        currentStatus.levels[4] = {
          status: progressUpdate.status || 'running',
          progress: progressUpdate.progress || 'Finalizing results...'
        };
      }

      // Update overall progress message if provided
      if (progressUpdate.progress && !level) {
        currentStatus.progress = progressUpdate.progress;
      }

      activeAnalyses.set(analysisId, currentStatus);
      broadcastProgress(analysisId, currentStatus);
    };

    // Start analysis asynchronously with progress callback and custom instructions
    // Use review.id (not prMetadata.id) to avoid ID collision with local mode
    // Pass analysisId for process tracking/cancellation
    analyzer.analyzeLevel1(review.id, worktreePath, prMetadata, progressCallback, combinedInstructions, null, { analysisId })
      .then(async result => {
        logger.section('Analysis Results');
        logger.success(`Analysis complete for PR #${prNumber}`);
        logger.success(`Found ${result.suggestions.length} suggestions:`);

        // Update pr_metadata with the last AI run ID (tracks that analysis was run)
        try {
          await run(db, `
            UPDATE pr_metadata SET last_ai_run_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `, [result.runId, prMetadata.id]);
          logger.info(`Updated pr_metadata with last_ai_run_id: ${result.runId}`);
        } catch (updateError) {
          logger.warn(`Failed to update pr_metadata with last_ai_run_id: ${updateError.message}`);
        }

        // Save summary to review record (reuse reviewRepo from handler start)
        if (result.summary) {
          try {
            await reviewRepo.upsertSummary(prNumber, repository, result.summary);
            logger.info(`Saved analysis summary to review record`);
            logger.section('Analysis Summary');
            logger.info(result.summary);
          } catch (summaryError) {
            logger.warn(`Failed to save analysis summary: ${summaryError.message}`);
          }
        }
        result.suggestions.forEach(s => {
          const icon = s.type === 'bug' ? '🐛' :
                       s.type === 'praise' ? '⭐' :
                       s.type === 'improvement' ? '💡' :
                       s.type === 'security' ? '🔒' :
                       s.type === 'performance' ? '⚡' :
                       s.type === 'design' ? '📐' :
                       s.type === 'suggestion' ? '💬' :
                       s.type === 'code-style' || s.type === 'style' ? '🧹' : '📝';
          logger.log('Result', `${icon} ${s.type}: ${s.title} (${s.file}:${s.line_start})`, 'green');
        });

        // Determine completion status using extracted helper function
        const completionInfo = determineCompletionInfo(result);

        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          console.warn('Analysis already completed or removed:', analysisId);
          return;
        }

        // Mark all completed levels as completed
        for (let i = 1; i <= completionInfo.completedLevel; i++) {
          currentStatus.levels[i] = {
            status: 'completed',
            progress: `Level ${i} complete`
          };
        }

        // Mark orchestration (level 4) as completed
        currentStatus.levels[4] = {
          status: 'completed',
          progress: 'Results finalized'
        };

        const completedStatus = {
          ...currentStatus,
          status: 'completed',
          level: completionInfo.completedLevel,
          completedLevel: completionInfo.completedLevel,
          completedAt: new Date().toISOString(),
          result,
          progress: completionInfo.progressMessage,
          suggestionsCount: completionInfo.totalSuggestions,
          filesAnalyzed: currentStatus?.filesAnalyzed || 0,
          filesRemaining: 0,
          currentFile: currentStatus?.totalFiles || 0,
          totalFiles: currentStatus?.totalFiles || 0
        };
        activeAnalyses.set(analysisId, completedStatus);

        // Broadcast completion status
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        const currentStatus = activeAnalyses.get(analysisId);
        if (!currentStatus) {
          console.warn('Analysis status not found during error handling:', analysisId);
          return;
        }

        // Handle cancellation gracefully - don't log as error
        if (error.isCancellation) {
          logger.info(`Analysis cancelled for PR #${prNumber}`);
          // Status is already set to 'cancelled' by the cancel endpoint
          return;
        }

        logger.error(`Analysis failed for PR #${prNumber}: ${error.message}`);

        // Mark all levels as failed
        for (let i = 1; i <= 4; i++) {
          currentStatus.levels[i] = {
            status: 'failed',
            progress: 'Failed'
          };
        }

        const failedStatus = {
          ...currentStatus,
          status: 'failed',
          level: 1,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);

        // Broadcast failure status
        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up PR to analysis ID mapping (always runs regardless of success/failure)
        const prKey = getPRKey(owner, repo, prNumber);
        prToAnalysisId.delete(prKey);
      });

    // Return analysis ID immediately
    res.json({
      analysisId,
      status: 'started',
      message: 'AI analysis started in background'
    });

  } catch (error) {
    console.error('Error starting AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start AI analysis'
    });
  }
});

/**
 * Trigger Level 2 AI analysis for a PR
 */
router.post('/api/analyze/:owner/:repo/:pr/level2', async (req, res) => {
  try {
    const { owner, repo, pr } = req.params;
    const prNumber = parseInt(pr);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Check if PR exists in database
    const db = req.app.get('db');
    const prMetadata = await queryOne(db, `
      SELECT id, base_branch, title, description, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    // Parse pr_data to get base_sha and head_sha
    let prData = {};
    try {
      prData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Merge parsed data into prMetadata for use in analysis
    prMetadata.base_sha = prData.base_sha;
    prMetadata.head_sha = prData.head_sha;

    // Get worktree path
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'started',
      level: 2,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 2 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store PR to analysis ID mapping
    const prKey = getPRKey(owner, repo, prNumber);
    prToAnalysisId.set(prKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Get or create a review record for this PR
    // The review.id is passed to the analyzer to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    // Create analyzer instance with model from config/CLI
    const model = getModel(req);
    const analyzer = new Analyzer(req.app.get('db'), model);

    logger.section(`Level 2 AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Review ID: ${review.id}`, 'magenta');
    logger.log('API', `Model: ${model}`, 'cyan');

    // Create progress callback function
    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        // Don't override the level if it's already set in progressUpdate
        level: progressUpdate.level || 2
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };

    // Start Level 2 analysis asynchronously using review.id
    analyzer.analyzeLevel2(review.id, worktreePath, prMetadata, progressCallback)
      .then(result => {
        const completedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'completed',
          level: 2,
          completedLevel: 2,
          completedAt: new Date().toISOString(),
          result,
          progress: `Level 2 analysis complete: ${result.suggestions.length} suggestions found`
        };
        activeAnalyses.set(analysisId, completedStatus);
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        const failedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'failed',
          level: 2,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Level 2 analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);
        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up PR to analysis ID mapping (always runs regardless of success/failure)
        const prKey = getPRKey(owner, repo, prNumber);
        prToAnalysisId.delete(prKey);
      });

    res.json({
      analysisId,
      status: 'started',
      level: 2,
      message: 'Level 2 AI analysis started in background'
    });

  } catch (error) {
    console.error('Error starting Level 2 AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start Level 2 AI analysis'
    });
  }
});

/**
 * Trigger Level 3 AI analysis for a PR
 */
router.post('/api/analyze/:owner/:repo/:pr/level3', async (req, res) => {
  try {
    const { owner, repo, pr } = req.params;
    const prNumber = parseInt(pr);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;

    // Check if PR exists in database
    const db = req.app.get('db');
    const prMetadata = await queryOne(db, `
      SELECT id, base_branch, title, description, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found. Please load the PR first.`
      });
    }

    // Parse pr_data to get base_sha and head_sha
    let prData = {};
    try {
      prData = prMetadata.pr_data ? JSON.parse(prMetadata.pr_data) : {};
    } catch (error) {
      console.warn('Error parsing PR data JSON:', error);
    }

    // Merge parsed data into prMetadata for use in analysis
    prMetadata.base_sha = prData.base_sha;
    prMetadata.head_sha = prData.head_sha;

    // Get worktree path
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    // Check if worktree exists
    if (!await worktreeManager.worktreeExists({ owner, repo, number: prNumber })) {
      return res.status(404).json({
        error: 'Worktree not found for this PR. Please reload the PR.'
      });
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status
    const initialStatus = {
      id: analysisId,
      prNumber,
      repository,
      status: 'started',
      level: 3,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 3 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store PR to analysis ID mapping
    const prKey = getPRKey(owner, repo, prNumber);
    prToAnalysisId.set(prKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Get or create a review record for this PR
    // The review.id is passed to the analyzer to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getOrCreate({ prNumber, repository });

    // Create analyzer instance with model from config/CLI
    const model = getModel(req);
    const analyzer = new Analyzer(req.app.get('db'), model);

    logger.section(`Level 3 AI Analysis Request - PR #${prNumber}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Review ID: ${review.id}`, 'magenta');
    logger.log('API', `Model: ${model}`, 'cyan');

    // Create progress callback function
    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        // Don't override the level if it's already set in progressUpdate
        level: progressUpdate.level || 3
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };

    // Start Level 3 analysis asynchronously using review.id
    analyzer.analyzeLevel3(review.id, worktreePath, prMetadata, progressCallback)
      .then(result => {
        const completedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'completed',
          level: 3,
          completedLevel: 3,
          completedAt: new Date().toISOString(),
          result,
          progress: `Level 3 analysis complete: ${result.suggestions.length} suggestions found`
        };
        activeAnalyses.set(analysisId, completedStatus);
        broadcastProgress(analysisId, completedStatus);
      })
      .catch(error => {
        const failedStatus = {
          ...activeAnalyses.get(analysisId),
          status: 'failed',
          level: 3,
          completedAt: new Date().toISOString(),
          error: error.message,
          progress: 'Level 3 analysis failed'
        };
        activeAnalyses.set(analysisId, failedStatus);
        broadcastProgress(analysisId, failedStatus);
      })
      .finally(() => {
        // Clean up PR to analysis ID mapping (always runs regardless of success/failure)
        const prKey = getPRKey(owner, repo, prNumber);
        prToAnalysisId.delete(prKey);
      });

    res.json({
      analysisId,
      status: 'started',
      level: 3,
      message: 'Level 3 AI analysis started in background'
    });

  } catch (error) {
    console.error('Error starting Level 3 AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start Level 3 AI analysis'
    });
  }
});

/**
 * Get AI analysis status
 */
router.get('/api/analyze/status/:id', async (req, res) => {
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
    console.error('Error fetching analysis status:', error);
    res.status(500).json({
      error: 'Failed to fetch analysis status'
    });
  }
});

/**
 * Cancel an active AI analysis
 */
router.post('/api/analyze/cancel/:id', async (req, res) => {
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

    // Update analysis status to cancelled
    const cancelledStatus = {
      ...analysis,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      progress: 'Analysis cancelled by user',
      levels: {
        ...analysis.levels,
        // Mark any running levels as cancelled
        // Note: Level 4 represents orchestration (the synthesis phase after levels 1-3)
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

    // Broadcast cancelled status to SSE clients
    broadcastProgress(id, cancelledStatus);

    // Clean up PR to analysis ID mapping (PR mode only)
    // Local mode cleanup is handled in the local.js analyze endpoint's .finally() block
    if (analysis.reviewType !== 'local' && analysis.repository && analysis.prNumber) {
      const [owner, repo] = analysis.repository.split('/');
      const prKey = getPRKey(owner, repo, analysis.prNumber);
      prToAnalysisId.delete(prKey);
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

/**
 * Check if analysis is running for a specific PR
 */
router.get('/api/pr/:owner/:repo/:number/analysis-status', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prKey = getPRKey(owner, repo, number);

    const analysisId = prToAnalysisId.get(prKey);

    if (!analysisId) {
      return res.json({
        running: false,
        analysisId: null,
        status: null
      });
    }

    const analysis = activeAnalyses.get(analysisId);

    if (!analysis) {
      // Clean up stale mapping
      prToAnalysisId.delete(prKey);
      return res.json({
        running: false,
        analysisId: null,
        status: null
      });
    }

    res.json({
      running: true,
      analysisId,
      status: analysis
    });

  } catch (error) {
    console.error('Error checking PR analysis status:', error);
    res.status(500).json({
      error: 'Failed to check analysis status'
    });
  }
});

/**
 * Check if a PR has existing AI suggestions
 * Also returns whether AI analysis has ever been run (even if no suggestions were found)
 */
router.get('/api/pr/:owner/:repo/:number/has-ai-suggestions', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');

    // Get PR metadata to verify PR exists and get last_ai_run_id
    const prMetadata = await queryOne(db, `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found`
      });
    }

    // Get review record for this PR (don't create one - GET should not have side effects)
    // Comments are associated with review.id to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    // If no review exists, no analysis has been run
    if (!review) {
      return res.json({
        hasSuggestions: false,
        analysisHasRun: false,
        summary: null,
        stats: { issues: 0, suggestions: 0, praise: 0 }
      });
    }

    // Check if any AI suggestions exist for this PR using review.id
    const result = await queryOne(db, `
      SELECT EXISTS(
        SELECT 1 FROM comments
        WHERE pr_id = ? AND source = 'ai'
      ) as has_suggestions
    `, [review.id]);

    const hasSuggestions = result?.has_suggestions === 1;

    // Check if any analysis has been run by looking for analysis_runs records
    // Falls back to checking pr_metadata.last_ai_run_id for backwards compatibility
    let analysisHasRun = hasSuggestions;
    try {
      const analysisRunRepo = new AnalysisRunRepository(db);
      const latestRun = await analysisRunRepo.getLatestByReviewId(review.id);
      // Analysis has been run if there's an analysis_run record OR if there are any AI suggestions
      analysisHasRun = !!(latestRun || hasSuggestions);
    } catch (e) {
      // If analysis_runs table doesn't exist yet, fall back to pr_metadata.last_ai_run_id
      try {
        const runCheck = await queryOne(db, `
          SELECT last_ai_run_id FROM pr_metadata
          WHERE id = ?
        `, [prMetadata.id]);
        analysisHasRun = !!(runCheck?.last_ai_run_id || hasSuggestions);
      } catch (fallbackError) {
        // Fall back to using hasSuggestions if both fail
        analysisHasRun = hasSuggestions;
      }
    }

    // Get AI summary from the review record (already fetched above)
    const summary = review?.summary || null;

    // Get stats for AI suggestions (issues/suggestions/praise for final level only)
    let stats = { issues: 0, suggestions: 0, praise: 0 };
    if (hasSuggestions) {
      try {
        const statsResult = await query(db, getStatsQuery(), [review.id, review.id]);
        stats = calculateStats(statsResult);
      } catch (e) {
        console.warn('Error fetching AI suggestion stats:', e);
      }
    }

    res.json({
      hasSuggestions: hasSuggestions,
      analysisHasRun: analysisHasRun,
      summary: summary,
      stats: stats
    });
  } catch (error) {
    console.error('Error checking for AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to check for AI suggestions'
    });
  }
});

/**
 * Get AI suggestions for a PR (compatibility endpoint with owner/repo/number)
 */
router.get('/api/pr/:owner/:repo/:number/ai-suggestions', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({
        error: 'Invalid pull request number'
      });
    }

    const repository = `${owner}/${repo}`;
    const db = req.app.get('db');

    // Get PR metadata to verify PR exists
    const prMetadata = await queryOne(db, `
      SELECT id FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prNumber, repository]);

    if (!prMetadata) {
      return res.status(404).json({
        error: `Pull request #${prNumber} not found`
      });
    }

    // Get review record for this PR (don't create one - GET should not have side effects)
    // Comments are associated with review.id to avoid ID collision with local mode
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getReviewByPR(prNumber, repository);

    // If no review exists, return empty suggestions
    if (!review) {
      return res.json({ suggestions: [] });
    }

    // Parse levels query parameter (e.g., ?levels=final,1,2)
    // Default to 'final' (orchestrated suggestions only) if not specified
    const levelsParam = req.query.levels || 'final';
    const requestedLevels = levelsParam.split(',').map(l => l.trim());

    // Build level filter clause
    const levelConditions = [];
    requestedLevels.forEach(level => {
      if (level === 'final') {
        levelConditions.push('ai_level IS NULL');
      } else if (['1', '2', '3'].includes(level)) {
        levelConditions.push(`ai_level = ${parseInt(level)}`);
      }
    });

    // If no valid levels specified, default to final
    const levelFilter = levelConditions.length > 0
      ? `(${levelConditions.join(' OR ')})`
      : 'ai_level IS NULL';

    // Get AI suggestions from the comments table
    // Only return suggestions from the latest analysis run (ai_run_id)
    // This preserves history while showing only the most recent results
    //
    // Note: If no AI suggestions exist (subquery returns NULL), the ai_run_id = NULL
    // comparison returns no rows. This is intentional - we only show suggestions
    // when there's a matching analysis run.
    //
    // Note: review.id is passed twice because SQLite requires separate parameters
    // for the outer WHERE clause and the subquery. A CTE could consolidate this but
    // adds complexity without meaningful benefit here.
    const suggestions = await query(db, `
      SELECT
        id,
        source,
        author,
        ai_run_id,
        ai_level,
        ai_confidence,
        file,
        line_start,
        line_end,
        side,
        type,
        title,
        body,
        status,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE pr_id = ?
        AND source = 'ai'
        AND ${levelFilter}
        AND status IN ('active', 'dismissed', 'adopted')
        AND ai_run_id = (
          SELECT ai_run_id FROM comments
          WHERE pr_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        )
      ORDER BY
        CASE
          WHEN ai_level IS NULL THEN 0
          WHEN ai_level = 1 THEN 1
          WHEN ai_level = 2 THEN 2
          WHEN ai_level = 3 THEN 3
          ELSE 4
        END,
        is_file_level DESC,
        file,
        line_start
    `, [review.id, review.id]);

    res.json({ suggestions });

  } catch (error) {
    console.error('Error fetching AI suggestions:', error);
    res.status(500).json({
      error: 'Failed to fetch AI suggestions'
    });
  }
});

/**
 * Server-Sent Events endpoint for AI analysis progress
 */
router.get('/api/pr/:id/ai-suggestions/status', (req, res) => {
  const analysisId = req.params.id;

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial connection message
  res.write('data: {"type":"connected","message":"Connected to progress stream"}\n\n');

  // Store client for this analysis
  if (!progressClients.has(analysisId)) {
    progressClients.set(analysisId, new Set());
  }
  progressClients.get(analysisId).add(res);

  // Send current status if analysis exists
  const currentStatus = activeAnalyses.get(analysisId);
  if (currentStatus) {
    res.write(`data: ${JSON.stringify({
      type: 'progress',
      ...currentStatus
    })}\n\n`);
  }

  // Handle client disconnect
  req.on('close', () => {
    const clients = progressClients.get(analysisId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        progressClients.delete(analysisId);
      }
    }
  });

  req.on('error', () => {
    const clients = progressClients.get(analysisId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        progressClients.delete(analysisId);
      }
    }
  });
});

/**
 * Get all analysis runs for a review
 * Works for both PR mode (owner/repo/pr) and local mode (reviewId)
 */
router.get('/api/analysis-runs/:reviewId', async (req, res) => {
  try {
    const { reviewId } = req.params;
    const db = req.app.locals.db;

    const analysisRunRepo = new AnalysisRunRepository(db);
    const runs = await analysisRunRepo.getByReviewId(parseInt(reviewId, 10));

    res.json({ runs });
  } catch (error) {
    console.error('Error fetching analysis runs:', error);
    res.status(500).json({ error: 'Failed to fetch analysis runs' });
  }
});

/**
 * Get the most recent analysis run for a review
 */
router.get('/api/analysis-runs/:reviewId/latest', async (req, res) => {
  try {
    const { reviewId } = req.params;
    const db = req.app.locals.db;

    const analysisRunRepo = new AnalysisRunRepository(db);
    const run = await analysisRunRepo.getLatestByReviewId(parseInt(reviewId, 10));

    if (!run) {
      return res.status(404).json({ error: 'No analysis runs found' });
    }

    res.json({ run });
  } catch (error) {
    console.error('Error fetching latest analysis run:', error);
    res.status(500).json({ error: 'Failed to fetch latest analysis run' });
  }
});

/**
 * Get a specific analysis run by ID
 */
router.get('/api/analysis-run/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const db = req.app.locals.db;

    const analysisRunRepo = new AnalysisRunRepository(db);
    const run = await analysisRunRepo.getById(runId);

    if (!run) {
      return res.status(404).json({ error: 'Analysis run not found' });
    }

    res.json({ run });
  } catch (error) {
    console.error('Error fetching analysis run:', error);
    res.status(500).json({ error: 'Failed to fetch analysis run' });
  }
});

module.exports = router;
