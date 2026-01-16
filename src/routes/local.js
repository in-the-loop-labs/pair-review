/**
 * Local Review Routes
 *
 * Handles all local review-related endpoints:
 * - Get local review metadata
 * - Get local diff
 * - Trigger AI analysis (Level 1, 2, 3)
 * - Get AI suggestions
 * - User comment CRUD operations
 *
 * Note: No submit-review endpoint - GitHub submission is disabled in local mode.
 */

const express = require('express');
const { query, queryOne, run, ReviewRepository, RepoSettingsRepository, CommentRepository, AnalysisRunRepository } = require('../database');
const Analyzer = require('../ai/analyzer');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { mergeInstructions } = require('../utils/instructions');
const { calculateStats, getStatsQuery } = require('../utils/stats-calculator');
const { generateLocalDiff, computeLocalDiffDigest } = require('../local-review');
const {
  activeAnalyses,
  progressClients,
  localReviewDiffs,
  getModel,
  determineCompletionInfo,
  broadcastProgress,
  CancellationError
} = require('./shared');

const router = express.Router();

// Store mapping of local review ID to analysis ID for tracking
const localReviewToAnalysisId = new Map();

/**
 * Generate a consistent key for local review mapping
 * @param {number} reviewId - Local review ID
 * @returns {string} Review key
 */
function getLocalReviewKey(reviewId) {
  return `local/${reviewId}`;
}

/**
 * Get local review metadata
 */
router.get('/api/local/:reviewId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // If the stored repository name doesn't look like owner/repo format,
    // try to get a fresh one from git remote for display purposes only.
    // Note: GET requests are read-only - no database writes here.
    // Repository name updates happen during session creation or refresh.
    let repositoryName = review.repository;
    if (repositoryName && !repositoryName.includes('/') && review.local_path) {
      try {
        const { getRepositoryName } = require('../local-review');
        const freshRepoName = await getRepositoryName(review.local_path);
        if (freshRepoName && freshRepoName.includes('/')) {
          repositoryName = freshRepoName;
          // Just use the fresh name for this response - don't write to DB in GET
          logger.log('API', `Using fresh repository name from git remote: ${freshRepoName}`, 'cyan');
        }
      } catch (repoError) {
        // Keep the original name if we can't get a better one
        logger.warn(`Could not refresh repository name: ${repoError.message}`);
      }
    }

    res.json({
      id: review.id,
      localPath: review.local_path,
      localHeadSha: review.local_head_sha,
      repository: repositoryName,
      branch: process.env.PAIR_REVIEW_BRANCH || 'unknown',
      reviewType: 'local',
      status: review.status,
      createdAt: review.created_at,
      updatedAt: review.updated_at
    });

  } catch (error) {
    console.error('Error fetching local review:', error);
    res.status(500).json({
      error: 'Failed to fetch local review'
    });
  }
});

/**
 * Get local diff
 */
router.get('/api/local/:reviewId/diff', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    // Verify the review exists
    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Get diff from module-level storage
    const diffData = localReviewDiffs.get(reviewId) || { diff: '', stats: {} };
    const { diff: diffContent, stats } = diffData;

    res.json({
      diff: diffContent || '',
      stats: {
        trackedChanges: stats?.trackedChanges || 0,
        untrackedFiles: stats?.untrackedFiles || 0,
        stagedChanges: stats?.stagedChanges || 0,
        unstagedChanges: stats?.unstagedChanges || 0
      }
    });

  } catch (error) {
    console.error('Error fetching local diff:', error);
    res.status(500).json({
      error: 'Failed to fetch local diff'
    });
  }
});

/**
 * Check if local review diff is stale (working directory has changed since diff was captured)
 * Uses a digest of the diff content for accurate change detection
 */
router.get('/api/local/:reviewId/check-stale', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.json({
        isStale: null,
        error: 'Local review not found'
      });
    }

    const localPath = review.local_path;
    if (!localPath) {
      return res.json({
        isStale: null,
        error: 'Local review missing path'
      });
    }

    // Get stored diff data
    const storedDiffData = localReviewDiffs.get(reviewId);
    if (!storedDiffData) {
      return res.json({
        isStale: null,
        error: 'No stored diff data found'
      });
    }

    // Check if baseline digest exists (must be computed at diff-capture time)
    if (!storedDiffData.digest) {
      // No baseline digest - session may predate staleness detection feature
      // Assume stale to be safe and prompt user to refresh
      return res.json({
        isStale: true,
        error: 'No baseline digest - please refresh to enable staleness detection'
      });
    }

    // Compute current digest to compare against baseline
    const currentDigest = await computeLocalDiffDigest(localPath);

    // If current digest computation failed, assume stale to be safe
    if (!currentDigest) {
      return res.json({
        isStale: true,
        error: 'Could not compute current digest - refresh recommended'
      });
    }

    const isStale = storedDiffData.digest !== currentDigest;

    res.json({
      isStale,
      storedDigest: storedDiffData.digest,
      currentDigest
    });

  } catch (error) {
    logger.warn(`Error checking local review staleness: ${error.message}`);
    res.json({
      isStale: null,
      error: error.message
    });
  }
});

/**
 * Start Level 1 AI analysis for local review
 */
router.post('/api/local/:reviewId/analyze', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

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

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    const localPath = review.local_path;
    const repository = review.repository;

    // Fetch repo settings for default instructions
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const repoSettings = repository ? await repoSettingsRepo.getRepoSettings(repository) : null;

    // Determine provider: request body > repo settings > config > default ('claude')
    let selectedProvider;
    if (requestProvider) {
      selectedProvider = requestProvider;
    } else if (repoSettings && repoSettings.default_provider) {
      selectedProvider = repoSettings.default_provider;
    } else {
      const config = req.app.get('config') || {};
      selectedProvider = config.provider || 'claude';
    }

    // Determine model: request body > repo settings > config/CLI > default
    let selectedModel;
    if (requestModel) {
      selectedModel = requestModel;
    } else if (repoSettings && repoSettings.default_model) {
      selectedModel = repoSettings.default_model;
    } else {
      selectedModel = getModel(req);
    }

    // Merge custom instructions using shared utility
    const repoInstructions = repoSettings?.default_instructions;
    const combinedInstructions = mergeInstructions(repoInstructions, requestInstructions);

    // Save custom instructions to the review record
    // Only update when requestInstructions has a value - updateReview would accept
    // null/undefined but we only want to persist actual user-provided instructions
    if (requestInstructions) {
      await reviewRepo.updateReview(reviewId, {
        customInstructions: requestInstructions
      });
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status with separate tracking for each level
    const initialStatus = {
      id: analysisId,
      reviewId,
      repository: repository,
      reviewType: 'local',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: 'Starting analysis...',
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

    // Store local review to analysis ID mapping
    const reviewKey = getLocalReviewKey(reviewId);
    localReviewToAnalysisId.set(reviewKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance with provider and model
    const analyzer = new Analyzer(db, selectedModel, selectedProvider);

    // Build local review metadata for the analyzer
    // The analyzer uses base_sha and head_sha for git diff commands
    // For local review, we use HEAD as both since we're diffing working directory
    const localMetadata = {
      id: reviewId,
      title: `Local changes in ${repository}`,
      description: `Reviewing uncommitted changes in ${localPath}`,
      base_sha: review.local_head_sha,  // HEAD commit
      head_sha: review.local_head_sha,  // HEAD commit (diff is against working directory)
      reviewType: 'local'
    };

    // Get changed files for local mode path validation
    // This is critical for local mode since git diff HEAD...HEAD returns nothing
    const changedFiles = await analyzer.getLocalChangedFiles(localPath);

    // Log analysis start
    logger.section(`Local AI Analysis Request - Review #${reviewId}`);
    logger.log('API', `Repository: ${repository}`, 'magenta');
    logger.log('API', `Local path: ${localPath}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Provider: ${selectedProvider}`, 'cyan');
    logger.log('API', `Model: ${selectedModel}`, 'cyan');
    logger.log('API', `Changed files: ${changedFiles.length}`, 'cyan');
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

    // Start analysis asynchronously (pass changedFiles for local mode path validation)
    // Pass analysisId for process tracking/cancellation
    analyzer.analyzeLevel1(reviewId, localPath, localMetadata, progressCallback, combinedInstructions, changedFiles, { analysisId })
      .then(async result => {
        logger.section('Local Analysis Results');
        logger.success(`Analysis complete for local review #${reviewId}`);
        logger.success(`Found ${result.suggestions.length} suggestions`);

        // Save summary to review record (reuse reviewRepo from handler start)
        if (result.summary) {
          try {
            await reviewRepo.updateSummary(reviewId, result.summary);
            logger.info(`Saved analysis summary to review record`);
            logger.section('Analysis Summary');
            logger.info(result.summary);
          } catch (summaryError) {
            logger.warn(`Failed to save analysis summary: ${summaryError.message}`);
          }
        }

        // Determine completion status
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
          filesRemaining: 0
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
          logger.info(`Local analysis cancelled for review #${reviewId}`);
          // Status is already set to 'cancelled' by the cancel endpoint
          return;
        }

        logger.error(`Local analysis failed for review #${reviewId}: ${error.message}`);

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
        // Clean up local review to analysis ID mapping
        const reviewKey = getLocalReviewKey(reviewId);
        localReviewToAnalysisId.delete(reviewKey);
      });

    // Return analysis ID immediately
    res.json({
      analysisId,
      status: 'started',
      message: 'AI analysis started in background'
    });

  } catch (error) {
    console.error('Error starting local AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start AI analysis'
    });
  }
});

/**
 * Start Level 2 AI analysis for local review
 */
router.post('/api/local/:reviewId/analyze/level2', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    // Extract optional provider and model from request body
    const { provider: requestProvider, model: requestModel } = req.body || {};

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    const localPath = review.local_path;

    // Determine provider and model
    let selectedProvider;
    if (requestProvider) {
      selectedProvider = requestProvider;
    } else {
      const config = req.app.get('config') || {};
      selectedProvider = config.provider || 'claude';
    }

    let selectedModel;
    if (requestModel) {
      selectedModel = requestModel;
    } else {
      selectedModel = getModel(req);
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status
    const initialStatus = {
      id: analysisId,
      reviewId,
      repository: review.repository,
      reviewType: 'local',
      status: 'started',
      level: 2,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 2 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store mapping
    const reviewKey = getLocalReviewKey(reviewId);
    localReviewToAnalysisId.set(reviewKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance with provider and model
    const analyzer = new Analyzer(db, selectedModel, selectedProvider);

    const localMetadata = {
      id: reviewId,
      title: `Local changes in ${review.repository}`,
      description: `Reviewing uncommitted changes in ${localPath}`,
      base_sha: review.local_head_sha,
      head_sha: review.local_head_sha,
      reviewType: 'local'
    };

    // Get changed files for local mode path validation
    const changedFiles = await analyzer.getLocalChangedFiles(localPath);

    logger.section(`Local Level 2 AI Analysis - Review #${reviewId}`);
    logger.log('API', `Repository: ${review.repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Provider: ${selectedProvider}`, 'cyan');
    logger.log('API', `Model: ${selectedModel}`, 'cyan');
    logger.log('API', `Changed files: ${changedFiles.length}`, 'cyan');

    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        level: progressUpdate.level || 2
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };

    // Start Level 2 analysis asynchronously (pass changedFiles for local mode path validation)
    analyzer.analyzeLevel2(reviewId, localPath, localMetadata, progressCallback, changedFiles)
      .then(async result => {
        // Store suggestions to database (standalone Level 2 doesn't store - orchestration normally handles this)
        await analyzer.storeSuggestions(reviewId, result.runId, result.suggestions, 2, changedFiles);

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
        const reviewKey = getLocalReviewKey(reviewId);
        localReviewToAnalysisId.delete(reviewKey);
      });

    res.json({
      analysisId,
      status: 'started',
      level: 2,
      message: 'Level 2 AI analysis started in background'
    });

  } catch (error) {
    console.error('Error starting Level 2 local AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start Level 2 AI analysis'
    });
  }
});

/**
 * Start Level 3 AI analysis for local review
 */
router.post('/api/local/:reviewId/analyze/level3', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    // Extract optional provider and model from request body
    const { provider: requestProvider, model: requestModel } = req.body || {};

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    const localPath = review.local_path;

    // Determine provider and model
    let selectedProvider;
    if (requestProvider) {
      selectedProvider = requestProvider;
    } else {
      const config = req.app.get('config') || {};
      selectedProvider = config.provider || 'claude';
    }

    let selectedModel;
    if (requestModel) {
      selectedModel = requestModel;
    } else {
      selectedModel = getModel(req);
    }

    // Create analysis ID
    const analysisId = uuidv4();

    // Store analysis status
    const initialStatus = {
      id: analysisId,
      reviewId,
      repository: review.repository,
      reviewType: 'local',
      status: 'started',
      level: 3,
      startedAt: new Date().toISOString(),
      progress: 'Starting Level 3 analysis...',
      filesAnalyzed: 0,
      filesRemaining: 0
    };
    activeAnalyses.set(analysisId, initialStatus);

    // Store mapping
    const reviewKey = getLocalReviewKey(reviewId);
    localReviewToAnalysisId.set(reviewKey, analysisId);

    // Broadcast initial status
    broadcastProgress(analysisId, initialStatus);

    // Create analyzer instance with provider and model
    const analyzer = new Analyzer(db, selectedModel, selectedProvider);

    const localMetadata = {
      id: reviewId,
      title: `Local changes in ${review.repository}`,
      description: `Reviewing uncommitted changes in ${localPath}`,
      base_sha: review.local_head_sha,
      head_sha: review.local_head_sha,
      reviewType: 'local'
    };

    // Get changed files for local mode path validation
    const changedFiles = await analyzer.getLocalChangedFiles(localPath);

    logger.section(`Local Level 3 AI Analysis - Review #${reviewId}`);
    logger.log('API', `Repository: ${review.repository}`, 'magenta');
    logger.log('API', `Analysis ID: ${analysisId}`, 'magenta');
    logger.log('API', `Provider: ${selectedProvider}`, 'cyan');
    logger.log('API', `Model: ${selectedModel}`, 'cyan');
    logger.log('API', `Changed files: ${changedFiles.length}`, 'cyan');

    const progressCallback = (progressUpdate) => {
      const updatedStatus = {
        ...activeAnalyses.get(analysisId),
        ...progressUpdate,
        level: progressUpdate.level || 3
      };
      activeAnalyses.set(analysisId, updatedStatus);
      broadcastProgress(analysisId, updatedStatus);
    };

    // Start Level 3 analysis asynchronously (pass changedFiles for local mode path validation)
    analyzer.analyzeLevel3(reviewId, localPath, localMetadata, progressCallback, changedFiles)
      .then(async result => {
        // Store suggestions to database (standalone Level 3 doesn't store - orchestration normally handles this)
        await analyzer.storeSuggestions(reviewId, result.runId, result.suggestions, 3, changedFiles);

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
        const reviewKey = getLocalReviewKey(reviewId);
        localReviewToAnalysisId.delete(reviewKey);
      });

    res.json({
      analysisId,
      status: 'started',
      level: 3,
      message: 'Level 3 AI analysis started in background'
    });

  } catch (error) {
    console.error('Error starting Level 3 local AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start Level 3 AI analysis'
    });
  }
});

/**
 * Get AI suggestions for a local review
 */
router.get('/api/local/:reviewId/suggestions', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');

    // Verify review exists
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
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
    // For local reviews, review_id stores the review ID
    // Only return suggestions from the latest analysis run (ai_run_id)
    // This preserves history while showing only the most recent results
    //
    // Note: If no AI suggestions exist (subquery returns NULL), the ai_run_id = NULL
    // comparison returns no rows. This is intentional - we only show suggestions
    // when there's a matching analysis run.
    //
    // Note: reviewId is passed twice because SQLite requires separate parameters
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
      WHERE review_id = ?
        AND source = 'ai'
        AND ${levelFilter}
        AND status IN ('active', 'dismissed', 'adopted')
        AND ai_run_id = (
          SELECT ai_run_id FROM comments
          WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
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
    `, [reviewId, reviewId]);

    res.json({ suggestions });

  } catch (error) {
    console.error('Error fetching local review suggestions:', error);
    res.status(500).json({
      error: 'Failed to fetch AI suggestions'
    });
  }
});

/**
 * Get user comments for a local review
 */
router.get('/api/local/:reviewId/user-comments', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');

    // Verify review exists
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.json({
        success: true,
        comments: []
      });
    }

    const comments = await query(db, `
      SELECT
        id,
        source,
        author,
        file,
        line_start,
        line_end,
        diff_position,
        side,
        type,
        title,
        body,
        status,
        parent_id,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE review_id = ? AND source = 'user' AND status IN ('active', 'submitted', 'draft')
      ORDER BY file, line_start, created_at
    `, [reviewId]);

    res.json({
      success: true,
      comments: comments || []
    });

  } catch (error) {
    console.error('Error fetching local review user comments:', error);
    res.status(500).json({
      error: 'Failed to fetch user comments'
    });
  }
});

/**
 * Add user comment to a local review
 */
router.post('/api/local/:reviewId/user-comments', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const { file, line_start, line_end, diff_position, side, body, parent_id, type, title } = req.body;

    if (!file || !line_start || !body) {
      return res.status(400).json({
        error: 'Missing required fields: file, line_start, body'
      });
    }

    const db = req.app.get('db');

    // Verify review exists
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: 'Local review not found'
      });
    }

    // Create line-level comment using repository
    const commentRepo = new CommentRepository(db);
    const commentId = await commentRepo.createLineComment({
      review_id: reviewId,
      file,
      line_start,
      line_end,
      diff_position,
      side,
      body,
      parent_id,
      type,
      title
    });

    res.json({
      success: true,
      commentId,
      message: 'Comment saved successfully'
    });

  } catch (error) {
    console.error('Error creating local review user comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to create comment'
    });
  }
});

/**
 * Create file-level user comment for a local review
 * File-level comments are about an entire file, not tied to specific lines
 */
router.post('/api/local/:reviewId/file-comment', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const { file, body, parent_id, type, title } = req.body;

    if (!file || !body) {
      return res.status(400).json({
        error: 'Missing required fields: file, body'
      });
    }

    // Validate body is not just whitespace
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      return res.status(400).json({
        error: 'Comment body cannot be empty or whitespace only'
      });
    }

    const db = req.app.get('db');

    // Verify review exists
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: 'Local review not found'
      });
    }

    // Create file-level comment using repository
    const commentRepo = new CommentRepository(db);
    const commentId = await commentRepo.createFileComment({
      review_id: reviewId,
      file,
      body: trimmedBody,
      type,
      title,
      parent_id
    });

    res.json({
      success: true,
      commentId,
      message: 'File-level comment saved successfully'
    });

  } catch (error) {
    console.error('Error creating file-level comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to create file-level comment'
    });
  }
});

/**
 * Update file-level comment in a local review
 */
router.put('/api/local/:reviewId/file-comment/:commentId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const commentId = parseInt(req.params.commentId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (isNaN(commentId) || commentId <= 0) {
      return res.status(400).json({
        error: 'Invalid comment ID'
      });
    }

    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({
        error: 'Comment body cannot be empty'
      });
    }

    const db = req.app.get('db');

    // Verify the comment exists, belongs to this review, and is a file-level comment
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user' AND is_file_level = 1
    `, [commentId, reviewId]);

    if (!comment) {
      return res.status(404).json({
        error: 'File-level comment not found'
      });
    }

    // Update comment
    await run(db, `
      UPDATE comments
      SET body = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [body.trim(), commentId]);

    res.json({
      success: true,
      message: 'File-level comment updated successfully'
    });

  } catch (error) {
    console.error('Error updating file-level comment:', error);
    res.status(500).json({
      error: 'Failed to update comment'
    });
  }
});

/**
 * Delete file-level comment from a local review
 */
router.delete('/api/local/:reviewId/file-comment/:commentId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const commentId = parseInt(req.params.commentId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (isNaN(commentId) || commentId <= 0) {
      return res.status(400).json({
        error: 'Invalid comment ID'
      });
    }

    const db = req.app.get('db');

    // Verify the comment exists, belongs to this review, and is a file-level comment
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user' AND is_file_level = 1
    `, [commentId, reviewId]);

    if (!comment) {
      return res.status(404).json({
        error: 'File-level comment not found'
      });
    }

    // Soft delete by setting status to inactive
    await run(db, `
      UPDATE comments
      SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [commentId]);

    res.json({
      success: true,
      message: 'File-level comment deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting file-level comment:', error);
    res.status(500).json({
      error: 'Failed to delete comment'
    });
  }
});

/**
 * Get a single user comment from a local review
 */
router.get('/api/local/:reviewId/user-comments/:commentId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const commentId = parseInt(req.params.commentId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (isNaN(commentId) || commentId <= 0) {
      return res.status(400).json({
        error: 'Invalid comment ID'
      });
    }

    const db = req.app.get('db');

    // Get the comment and verify it belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [commentId, reviewId]);

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    res.json({
      id: comment.id,
      file: comment.file,
      line_start: comment.line_start,
      line_end: comment.line_end,
      body: comment.body,
      type: comment.type,
      title: comment.title,
      status: comment.status,
      created_at: comment.created_at,
      updated_at: comment.updated_at
    });

  } catch (error) {
    console.error('Error fetching local review user comment:', error);
    res.status(500).json({
      error: 'Failed to fetch comment'
    });
  }
});

/**
 * Update user comment in a local review
 */
router.put('/api/local/:reviewId/user-comments/:commentId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const commentId = parseInt(req.params.commentId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (isNaN(commentId) || commentId <= 0) {
      return res.status(400).json({
        error: 'Invalid comment ID'
      });
    }

    const { body } = req.body;

    if (!body || !body.trim()) {
      return res.status(400).json({
        error: 'Comment body cannot be empty'
      });
    }

    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [commentId, reviewId]);

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    // Update comment
    await run(db, `
      UPDATE comments
      SET body = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [body.trim(), commentId]);

    res.json({
      success: true,
      message: 'Comment updated successfully'
    });

  } catch (error) {
    console.error('Error updating local review user comment:', error);
    res.status(500).json({
      error: 'Failed to update comment'
    });
  }
});

/**
 * Bulk delete all user comments for a local review
 * Also dismisses any AI suggestions that were parents of the deleted comments.
 */
router.delete('/api/local/:reviewId/user-comments', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');

    // Verify review exists
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Begin transaction to ensure atomicity
    await run(db, 'BEGIN TRANSACTION');

    try {
      // Bulk delete using repository (also dismisses parent AI suggestions)
      const commentRepo = new CommentRepository(db);
      const result = await commentRepo.bulkDeleteComments(reviewId);

      // Commit transaction
      await run(db, 'COMMIT');

      res.json({
        success: true,
        deletedCount: result.deletedCount,
        dismissedSuggestionIds: result.dismissedSuggestionIds,
        message: `Deleted ${result.deletedCount} user comment${result.deletedCount !== 1 ? 's' : ''}`
      });

    } catch (transactionError) {
      // Rollback transaction on error
      await run(db, 'ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('Error deleting all local review user comments:', error);
    res.status(500).json({
      error: 'Failed to delete comments'
    });
  }
});

/**
 * Delete user comment from a local review
 * If the comment was adopted from an AI suggestion, the parent suggestion
 * is automatically transitioned to 'dismissed' state.
 */
router.delete('/api/local/:reviewId/user-comments/:commentId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const commentId = parseInt(req.params.commentId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (isNaN(commentId) || commentId <= 0) {
      return res.status(400).json({
        error: 'Invalid comment ID'
      });
    }

    const db = req.app.get('db');

    // Verify the comment exists and belongs to this review
    const comment = await queryOne(db, `
      SELECT * FROM comments WHERE id = ? AND review_id = ? AND source = 'user'
    `, [commentId, reviewId]);

    if (!comment) {
      return res.status(404).json({
        error: 'User comment not found'
      });
    }

    // Use CommentRepository to delete (also dismisses parent AI suggestion if applicable)
    const commentRepo = new CommentRepository(db);
    const result = await commentRepo.deleteComment(commentId);

    res.json({
      success: true,
      message: 'Comment deleted successfully',
      dismissedSuggestionId: result.dismissedSuggestionId
    });

  } catch (error) {
    console.error('Error deleting local review user comment:', error);
    res.status(500).json({
      error: 'Failed to delete comment'
    });
  }
});

/**
 * Check if analysis is running for a local review
 */
router.get('/api/local/:reviewId/analysis-status', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const reviewKey = getLocalReviewKey(reviewId);
    const analysisId = localReviewToAnalysisId.get(reviewKey);

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
      localReviewToAnalysisId.delete(reviewKey);
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
    console.error('Error checking local review analysis status:', error);
    res.status(500).json({
      error: 'Failed to check analysis status'
    });
  }
});

/**
 * Check if a local review has existing AI suggestions
 */
router.get('/api/local/:reviewId/has-ai-suggestions', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');

    // Verify review exists
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Check if any AI suggestions exist for this review
    const result = await queryOne(db, `
      SELECT EXISTS(
        SELECT 1 FROM comments
        WHERE review_id = ? AND source = 'ai'
      ) as has_suggestions
    `, [reviewId]);

    const hasSuggestions = result?.has_suggestions === 1;

    // Check if any analysis has been run using analysis_runs table
    let analysisHasRun = hasSuggestions;
    try {
      const analysisRunRepo = new AnalysisRunRepository(db);
      const latestRun = await analysisRunRepo.getLatestByReviewId(reviewId);
      analysisHasRun = !!(latestRun || hasSuggestions);
    } catch (e) {
      // Fall back to using hasSuggestions if analysis_runs table doesn't exist
      analysisHasRun = hasSuggestions;
    }

    // Get AI summary from the review record
    const summary = review?.summary || null;

    // Get stats for AI suggestions (issues/suggestions/praise for final level only)
    let stats = { issues: 0, suggestions: 0, praise: 0 };
    if (hasSuggestions) {
      try {
        const statsResult = await query(db, getStatsQuery(), [reviewId, reviewId]);
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
 * Server-Sent Events endpoint for local review AI analysis progress
 */
router.get('/api/local/:reviewId/ai-suggestions/status', (req, res) => {
  const reviewId = parseInt(req.params.reviewId);

  // Find the analysis ID for this local review
  const reviewKey = getLocalReviewKey(reviewId);
  const analysisId = localReviewToAnalysisId.get(reviewKey);

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

  // If we have an analysis ID, use it; otherwise use a placeholder
  const trackingId = analysisId || `local-${reviewId}`;

  // Store client for this analysis
  if (!progressClients.has(trackingId)) {
    progressClients.set(trackingId, new Set());
  }
  progressClients.get(trackingId).add(res);

  // Send current status if analysis exists
  if (analysisId) {
    const currentStatus = activeAnalyses.get(analysisId);
    if (currentStatus) {
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        ...currentStatus
      })}\n\n`);
    }
  }

  // Handle client disconnect
  req.on('close', () => {
    const clients = progressClients.get(trackingId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        progressClients.delete(trackingId);
      }
    }
  });

  req.on('error', () => {
    const clients = progressClients.get(trackingId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        progressClients.delete(trackingId);
      }
    }
  });
});

/**
 * Refresh the diff for a local review
 * Regenerates the diff from the current state of the working directory
 * Returns sessionChanged flag if HEAD has changed since the session was created
 */
router.post('/api/local/:reviewId/refresh', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    const localPath = review.local_path;
    const originalHeadSha = review.local_head_sha;

    if (!localPath) {
      return res.status(400).json({
        error: 'Local review is missing path information'
      });
    }

    logger.log('API', `Refreshing diff for local review #${reviewId}`, 'cyan');
    logger.log('API', `Local path: ${localPath}`, 'magenta');

    // Check if HEAD has changed
    const { getHeadSha } = require('../local-review');
    let currentHeadSha;
    let sessionChanged = false;
    let newSessionId = null;

    try {
      currentHeadSha = await getHeadSha(localPath);

      if (originalHeadSha && currentHeadSha !== originalHeadSha) {
        sessionChanged = true;
        logger.log('API', `HEAD changed: ${originalHeadSha.substring(0, 7)} -> ${currentHeadSha.substring(0, 7)}`, 'yellow');

        // Check if a session already exists for the new HEAD
        const existingSession = await reviewRepo.getLocalReview(localPath, currentHeadSha);
        if (existingSession) {
          newSessionId = existingSession.id;
          logger.log('API', `Existing session found for new HEAD: ${newSessionId}`, 'cyan');
        } else {
          // Create a new session for the new HEAD
          const { getRepositoryName } = require('../local-review');
          const repository = await getRepositoryName(localPath);
          newSessionId = await reviewRepo.upsertLocalReview({
            localPath: localPath,
            localHeadSha: currentHeadSha,
            repository
          });
          logger.log('API', `Created new session for new HEAD: ${newSessionId}`, 'cyan');
        }
      }
    } catch (headError) {
      logger.warn(`Could not check HEAD SHA: ${headError.message}`);
    }

    // Regenerate the diff from the working directory
    const { diff, stats } = await generateLocalDiff(localPath);

    // Compute fresh digest for the new diff
    const digest = await computeLocalDiffDigest(localPath);

    // Update the stored diff data for the appropriate session
    const targetSessionId = sessionChanged ? newSessionId : reviewId;
    localReviewDiffs.set(targetSessionId, { diff, stats, digest });

    logger.success(`Diff refreshed: ${stats.unstagedChanges} unstaged, ${stats.untrackedFiles} untracked${stats.stagedChanges > 0 ? ` (${stats.stagedChanges} staged excluded)` : ''}`);

    res.json({
      success: true,
      message: 'Diff refreshed successfully',
      sessionChanged,
      newSessionId: sessionChanged ? newSessionId : null,
      newHeadSha: sessionChanged ? currentHeadSha : null,
      originalHeadSha: originalHeadSha,
      stats: {
        trackedChanges: stats.trackedChanges || 0,
        untrackedFiles: stats.untrackedFiles || 0,
        stagedChanges: stats.stagedChanges || 0,
        unstagedChanges: stats.unstagedChanges || 0
      }
    });

  } catch (error) {
    console.error('Error refreshing local diff:', error);
    res.status(500).json({
      error: 'Failed to refresh diff: ' + error.message
    });
  }
});

/**
 * Get review settings for a local review
 * Returns the custom_instructions from the review record
 */
router.get('/api/local/:reviewId/review-settings', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.json({
        custom_instructions: null
      });
    }

    res.json({
      custom_instructions: review.custom_instructions || null
    });

  } catch (error) {
    console.error('Error fetching local review settings:', error);
    res.status(500).json({
      error: 'Failed to fetch review settings'
    });
  }
});

/**
 * Save review settings for a local review
 * Saves the custom_instructions to the review record
 */
router.post('/api/local/:reviewId/review-settings', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const { custom_instructions } = req.body;

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getLocalReviewById(reviewId);

    if (!review) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Update the review with custom instructions
    await reviewRepo.updateReview(reviewId, {
      customInstructions: custom_instructions || null
    });

    res.json({
      success: true,
      custom_instructions: custom_instructions || null
    });

  } catch (error) {
    console.error('Error saving local review settings:', error);
    res.status(500).json({
      error: 'Failed to save review settings'
    });
  }
});

/**
 * Get all analysis runs for a local review
 */
router.get('/api/local/:reviewId/analysis-runs', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const runs = await analysisRunRepo.getByReviewId(reviewId);

    res.json({ runs });
  } catch (error) {
    console.error('Error fetching analysis runs:', error);
    res.status(500).json({ error: 'Failed to fetch analysis runs' });
  }
});

/**
 * Get the most recent analysis run for a local review
 */
router.get('/api/local/:reviewId/analysis-runs/latest', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId, 10);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({ error: 'Invalid review ID' });
    }

    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const run = await analysisRunRepo.getLatestByReviewId(reviewId);

    if (!run) {
      return res.status(404).json({ error: 'No analysis runs found' });
    }

    res.json({ run });
  } catch (error) {
    console.error('Error fetching latest analysis run:', error);
    res.status(500).json({ error: 'Failed to fetch latest analysis run' });
  }
});

module.exports = router;
