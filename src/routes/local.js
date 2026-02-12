// SPDX-License-Identifier: GPL-3.0-or-later
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
const path = require('path');
const fs = require('fs').promises;
const { query, queryOne, run, ReviewRepository, RepoSettingsRepository, CommentRepository, AnalysisRunRepository, ChatRepository } = require('../database');
const Analyzer = require('../ai/analyzer');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { mergeInstructions } = require('../utils/instructions');
const { calculateStats, getStatsQuery } = require('../utils/stats-calculator');
const { generateLocalDiff, computeLocalDiffDigest } = require('../local-review');
const { getGeneratedFilePatterns } = require('../git/gitattributes');
const { ChatService } = require('../services/chat-service');
const {
  activeAnalyses,
  progressClients,
  localReviewDiffs,
  localReviewToAnalysisId,
  getModel,
  getLocalReviewKey,
  determineCompletionInfo,
  broadcastProgress,
  CancellationError,
  createProgressCallback,
  parseEnabledLevels
} = require('./shared');

const router = express.Router();

/**
 * Open native OS directory picker dialog and return the selected path.
 * Uses osascript on macOS, zenity/kdialog on Linux, PowerShell on Windows.
 * Must be registered BEFORE /:reviewId param routes.
 */
router.post('/api/local/browse', async (req, res) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    let selectedPath = null;
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS: use osascript to open native folder picker
      const { stdout } = await execFileAsync('osascript', [
        '-e', 'set selectedFolder to POSIX path of (choose folder with prompt "Select a directory to review")',
      ], { timeout: 120000 });
      selectedPath = stdout.trim();
      // osascript appends trailing slash; remove it for consistency
      if (selectedPath.endsWith('/') && selectedPath.length > 1) {
        selectedPath = selectedPath.slice(0, -1);
      }
    } else if (platform === 'win32') {
      // Windows: use PowerShell folder browser dialog
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "Select a directory to review"
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $dialog.SelectedPath
        }
      `;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript], { timeout: 120000 });
      selectedPath = stdout.trim();
    } else {
      // Linux: try zenity first, then kdialog
      try {
        const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select a directory to review'], { timeout: 120000 });
        selectedPath = stdout.trim();
      } catch (zenityError) {
        if (zenityError.code === 1) {
          // Exit code 1 means user cancelled the dialog
          return res.json({ success: true, path: null, cancelled: true });
        }
        // Only fall through to kdialog if zenity is not installed (code 127 or ENOENT)
        if (zenityError.code !== 127 && zenityError.code !== 'ENOENT') {
          return res.status(500).json({
            error: 'Directory picker failed: ' + (zenityError.message || 'Unknown error')
          });
        }
        try {
          const { stdout } = await execFileAsync('kdialog', ['--getexistingdirectory', '.', '--title', 'Select a directory to review'], { timeout: 120000 });
          selectedPath = stdout.trim();
        } catch (kdialogError) {
          if (kdialogError.code === 1) {
            return res.json({ success: true, path: null, cancelled: true });
          }
          return res.status(501).json({
            error: 'No supported file dialog found. Install zenity or kdialog, or enter the path manually.'
          });
        }
      }
    }

    if (!selectedPath) {
      // User cancelled the dialog
      return res.json({ success: true, path: null, cancelled: true });
    }

    res.json({ success: true, path: selectedPath, cancelled: false });

  } catch (error) {
    // User cancellation on macOS throws error code -128
    if (error.code === 1 || (error.message && error.message.includes('-128'))) {
      return res.json({ success: true, path: null, cancelled: true });
    }
    // Handle timeout (process killed)
    if (error.killed) {
      return res.status(504).json({
        error: 'Directory picker timed out'
      });
    }
    logger.error(`Error opening directory picker: ${error.message}`);
    res.status(500).json({
      error: 'Failed to open directory picker'
    });
  }
});

/**
 * List local review sessions with pagination
 * Must be registered BEFORE /:reviewId param routes
 */
router.get('/api/local/sessions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const before = req.query.before || undefined;

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const { sessions, hasMore } = await reviewRepo.listLocalSessions({ limit, before });

    res.json({
      success: true,
      sessions,
      hasMore
    });

  } catch (error) {
    logger.error(`Error listing local sessions: ${error.message}`);
    res.status(500).json({
      error: 'Failed to list local sessions'
    });
  }
});

/**
 * Delete a local review session
 * Must be registered BEFORE /:reviewId param routes
 * Only deletes DB records — does NOT remove files on disk.
 */
router.delete('/api/local/sessions/:reviewId', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const deleted = await reviewRepo.deleteLocalSession(reviewId);

    if (!deleted) {
      return res.status(404).json({
        error: `Local review #${reviewId} not found`
      });
    }

    // Clean up in-memory diff cache to avoid stale data
    localReviewDiffs.delete(reviewId);

    logger.success(`Deleted local review session #${reviewId}`);

    res.json({
      success: true,
      reviewId
    });

  } catch (error) {
    logger.error(`Error deleting local session: ${error.message}`);
    res.status(500).json({
      error: 'Failed to delete local session'
    });
  }
});

/**
 * Start a new local review from the web UI
 * Must be registered BEFORE /:reviewId param routes
 */
router.post('/api/local/start', async (req, res) => {
  try {
    const { path: inputPath } = req.body || {};

    if (!inputPath || typeof inputPath !== 'string' || !inputPath.trim()) {
      return res.status(400).json({
        error: 'Missing required field: path'
      });
    }

    // Required inline (not reusing top-level import) so that vi.spyOn()
    // replacements on the module exports are visible at call time in integration tests.
    const { findGitRoot, getHeadSha, getRepositoryName, getCurrentBranch } = require('../local-review');

    // Resolve the path
    const resolvedPath = path.resolve(inputPath.trim());

    // Validate path exists
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({
          error: 'Path is not a directory'
        });
      }
    } catch (err) {
      return res.status(400).json({
        error: 'Path does not exist'
      });
    }

    // Find git root
    let repoPath;
    try {
      repoPath = await findGitRoot(resolvedPath);
    } catch (err) {
      return res.status(400).json({
        error: 'Not a git repository'
      });
    }

    // Gather git info
    const headSha = await getHeadSha(repoPath);
    const repository = await getRepositoryName(repoPath);
    const branch = await getCurrentBranch(repoPath);

    // Create or resume session
    const db = req.app.get('db');
    const reviewRepo = new ReviewRepository(db);
    const sessionId = await reviewRepo.upsertLocalReview({
      localPath: repoPath,
      localHeadSha: headSha,
      repository
    });

    // Generate diff
    logger.log('API', `Starting local review for ${repoPath}`, 'cyan');
    const { diff, stats } = await generateLocalDiff(repoPath);

    // Compute digest for staleness detection
    const digest = await computeLocalDiffDigest(repoPath);

    // Persist to in-memory Map
    localReviewDiffs.set(sessionId, { diff, stats, digest });

    // Persist to database
    await reviewRepo.saveLocalDiff(sessionId, { diff, stats, digest });

    logger.success(`Local review session #${sessionId} started for ${repository} (branch: ${branch})`);

    res.json({
      success: true,
      reviewUrl: `/local/${sessionId}`,
      sessionId,
      repository,
      branch,
      stats: {
        trackedChanges: stats.trackedChanges || 0,
        untrackedFiles: stats.untrackedFiles || 0,
        stagedChanges: stats.stagedChanges || 0,
        unstagedChanges: stats.unstagedChanges || 0
      }
    });

  } catch (error) {
    logger.error(`Error starting local review: ${error.message}`);
    res.status(500).json({
      error: 'Failed to start local review'
    });
  }
});

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
    let branchName = 'unknown';
    if (review.local_path) {
      try {
        const { getRepositoryName, getCurrentBranch } = require('../local-review');

        // Always fetch current branch from the working directory
        branchName = await getCurrentBranch(review.local_path);

        if (repositoryName && !repositoryName.includes('/')) {
          const freshRepoName = await getRepositoryName(review.local_path);
          if (freshRepoName && freshRepoName.includes('/')) {
            repositoryName = freshRepoName;
            // Just use the fresh name for this response - don't write to DB in GET
            logger.log('API', `Using fresh repository name from git remote: ${freshRepoName}`, 'cyan');
          }
        }
      } catch (repoError) {
        // Keep the original name if we can't get a better one
        logger.warn(`Could not refresh repository/branch info: ${repoError.message}`);
      }
    }

    // Fall back to env var if local_path is not available (e.g. CLI-started sessions)
    if (branchName === 'unknown') {
      branchName = process.env.PAIR_REVIEW_BRANCH || 'unknown';
      if (branchName !== 'unknown') {
        logger.log('API', `Using PAIR_REVIEW_BRANCH env var for branch: ${branchName}`, 'cyan');
      }
    }

    res.json({
      id: review.id,
      localPath: review.local_path,
      localHeadSha: review.local_head_sha,
      repository: repositoryName,
      branch: branchName,
      reviewType: 'local',
      status: review.status,
      name: review.name || null,
      createdAt: review.created_at,
      updatedAt: review.updated_at
    });

  } catch (error) {
    logger.error('Error fetching local review:', error.stack || error.message);
    res.status(500).json({
      error: 'Failed to fetch local review'
    });
  }
});

/**
 * Update local review session name
 */
router.patch('/api/local/:reviewId/name', async (req, res) => {
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

    // Allow null to clear the name, otherwise trim and cap at 200 chars
    let { name } = req.body;
    if (name !== null && name !== undefined) {
      name = String(name).trim().slice(0, 200) || null;
    }

    await reviewRepo.updateReview(reviewId, { name });

    res.json({
      success: true,
      name
    });

  } catch (error) {
    logger.error(`Error updating local review name: ${error.message}`);
    res.status(500).json({
      error: 'Failed to update review name'
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

    // Get diff from module-level storage, falling back to database
    let diffData = localReviewDiffs.get(reviewId);

    if (!diffData) {
      // Try loading from database
      const persistedDiff = await reviewRepo.getLocalDiff(reviewId);
      if (persistedDiff) {
        diffData = persistedDiff;
        // Cache-warm the in-memory Map
        localReviewDiffs.set(reviewId, diffData);
        logger.log('API', `Loaded persisted diff from DB for review #${reviewId}`, 'cyan');
      } else {
        diffData = { diff: '', stats: {} };
      }
    }

    const { diff: diffContent, stats } = diffData;

    // Detect generated files via .gitattributes
    let generatedFiles = [];
    if (diffContent && review.local_path) {
      try {
        const gitattributes = await getGeneratedFilePatterns(review.local_path);
        if (gitattributes.getPatterns().length > 0) {
          // Extract file paths from the diff header lines (--- a/path and +++ b/path)
          const filePathRegex = /^diff --git a\/.+? b\/(.+)$/gm;
          let match;
          while ((match = filePathRegex.exec(diffContent)) !== null) {
            const filePath = match[1];
            if (gitattributes.isGenerated(filePath)) {
              generatedFiles.push(filePath);
            }
          }
        }
      } catch (error) {
        logger.warn(`Could not load .gitattributes: ${error.message}`);
      }
    }

    res.json({
      diff: diffContent || '',
      generated_files: generatedFiles,
      stats: {
        trackedChanges: stats?.trackedChanges || 0,
        untrackedFiles: stats?.untrackedFiles || 0,
        stagedChanges: stats?.stagedChanges || 0,
        unstagedChanges: stats?.unstagedChanges || 0
      }
    });

  } catch (error) {
    logger.error('Error fetching local diff:', error);
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

    // Get stored diff data (in-memory first, then fall back to DB)
    let storedDiffData = localReviewDiffs.get(reviewId);
    if (!storedDiffData) {
      const persistedDiff = await reviewRepo.getLocalDiff(reviewId);
      if (persistedDiff) {
        storedDiffData = persistedDiff;
        // Cache-warm the in-memory Map
        localReviewDiffs.set(reviewId, storedDiffData);
        logger.log('API', `Loaded persisted diff from DB for staleness check on review #${reviewId}`, 'cyan');
      } else {
        return res.json({
          isStale: null,
          error: 'No stored diff data found'
        });
      }
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

    // Extract optional provider, model, tier, customInstructions and skipLevel3 from request body
    const { provider: requestProvider, model: requestModel, tier: requestTier, customInstructions: rawInstructions, skipLevel3: requestSkipLevel3, enabledLevels: requestEnabledLevels } = req.body || {};

    // Trim and validate custom instructions
    const MAX_INSTRUCTIONS_LENGTH = 5000;
    let requestInstructions = rawInstructions?.trim() || null;
    if (requestInstructions && requestInstructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return res.status(400).json({
        error: `Custom instructions exceed maximum length of ${MAX_INSTRUCTIONS_LENGTH} characters`
      });
    }

    // Validate tier
    const VALID_TIERS = ['fast', 'balanced', 'thorough', 'free', 'standard', 'premium'];
    if (requestTier && !VALID_TIERS.includes(requestTier)) {
      return res.status(400).json({
        error: `Invalid tier: "${requestTier}". Valid tiers: ${VALID_TIERS.join(', ')}`
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
      selectedProvider = config.default_provider || config.provider || 'claude';
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

    // Get repo instructions from settings
    const repoInstructions = repoSettings?.default_instructions || null;
    // Merge for logging purposes (analyzer will also merge internally)
    const combinedInstructions = mergeInstructions(repoInstructions, requestInstructions);

    // Save custom instructions to the review record
    // Only update when requestInstructions has a value - updateReview would accept
    // null/undefined but we only want to persist actual user-provided instructions
    if (requestInstructions) {
      await reviewRepo.updateReview(reviewId, {
        customInstructions: requestInstructions
      });
    }

    // Create unified run/analysis ID
    const runId = uuidv4();
    const analysisId = runId;

    // Create DB analysis_runs record immediately so it's queryable for polling
    const analysisRunRepo = new AnalysisRunRepository(db);
    const levelsConfig = parseEnabledLevels(requestEnabledLevels, requestSkipLevel3);
    try {
      await analysisRunRepo.create({
        id: runId,
        reviewId,
        provider: selectedProvider,
        model: selectedModel,
        repoInstructions,
        requestInstructions,
        headSha: review.local_head_sha || null,
        configType: 'single',
        levelsConfig
      });
    } catch (error) {
      logger.error('Failed to create analysis run record:', error);
      return res.status(500).json({ error: 'Failed to initialize analysis tracking' });
    }

    // Store analysis status with separate tracking for each level
    const initialStatus = {
      id: analysisId,
      runId,
      reviewId,
      repository: repository,
      reviewType: 'local',
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: 'Starting analysis...',
      levels: {
        1: levelsConfig[1] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        2: levelsConfig[2] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
        3: levelsConfig[3] ? { status: 'running', progress: 'Starting...' } : { status: 'skipped', progress: 'Skipped' },
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
      repository: review.repository,  // Include repository for context display
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
    // Determine tier: request body > default ('balanced')
    const tier = requestTier || 'balanced';
    logger.log('API', `Tier: ${tier}`, 'cyan');
    logger.log('API', `Changed files: ${changedFiles.length}`, 'cyan');
    if (combinedInstructions) {
      logger.log('API', `Custom instructions: ${combinedInstructions.length} chars`, 'cyan');
    }

    const progressCallback = createProgressCallback(analysisId);

    // Start analysis asynchronously (skipRunCreation since we created the record above; also passes changedFiles for local mode path validation, tier for prompt selection, and skipLevel3 flag)
    analyzer.analyzeLevel1(reviewId, localPath, localMetadata, progressCallback, { repoInstructions, requestInstructions }, changedFiles, { analysisId, runId, skipRunCreation: true, tier, skipLevel3: requestSkipLevel3, enabledLevels: levelsConfig })
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
          logger.warn('Analysis already completed or removed:', analysisId);
          return;
        }

        // Check if analysis was cancelled while running
        if (currentStatus.status === 'cancelled') {
          logger.info(`Analysis ${analysisId} was cancelled, skipping completion update`);
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
          logger.warn('Analysis status not found during error handling:', analysisId);
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

    // Return analysis ID immediately (runId added for unified ID)
    res.json({
      analysisId,
      runId,
      status: 'started',
      message: 'AI analysis started in background'
    });

  } catch (error) {
    logger.error('Error starting local AI analysis:', error);
    res.status(500).json({
      error: 'Failed to start AI analysis'
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

    // Parse optional runId query parameter to fetch suggestions from a specific analysis run
    // If not provided, defaults to the latest run
    const runIdParam = req.query.runId;

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

    // Build the run ID filter clause
    // If a specific runId is provided, use it directly; otherwise use subquery for latest
    let runIdFilter;
    let queryParams;
    if (runIdParam) {
      runIdFilter = 'ai_run_id = ?';
      queryParams = [reviewId, runIdParam];
    } else {
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
      runIdFilter = `ai_run_id = (
          SELECT ai_run_id FROM comments
          WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
        )`;
      queryParams = [reviewId, reviewId];
    }

    const rows = await query(db, `
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
        reasoning,
        status,
        is_file_level,
        created_at,
        updated_at
      FROM comments
      WHERE review_id = ?
        AND source = 'ai'
        AND ${levelFilter}
        AND status IN ('active', 'dismissed', 'adopted', 'draft', 'submitted')
        AND (is_raw = 0 OR is_raw IS NULL)
        AND ${runIdFilter}
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
    `, queryParams);

    const suggestions = rows.map(row => ({
      ...row,
      reasoning: row.reasoning ? JSON.parse(row.reasoning) : null
    }));

    res.json({ suggestions });

  } catch (error) {
    logger.error('Error fetching local review suggestions:', error);
    res.status(500).json({
      error: 'Failed to fetch AI suggestions'
    });
  }
});

/**
 * Get user comments for a local review
 * Uses CommentRepository.getUserComments() for consistency with PR mode
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

    // Use CommentRepository for consistency with PR mode
    // This ensures both modes use the same query logic and include the same columns
    const commentRepo = new CommentRepository(db);
    const { includeDismissed } = req.query;
    const comments = await commentRepo.getUserComments(reviewId, {
      includeDismissed: includeDismissed === 'true'
    });

    res.json({
      success: true,
      comments: comments || []
    });

  } catch (error) {
    logger.error('Error fetching local review user comments:', error);
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
    logger.error('Error creating local review user comment:', error);
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
    logger.error('Error creating file-level comment:', error);
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
    logger.error('Error updating file-level comment:', error);
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

    // Use CommentRepository to delete (also dismisses parent AI suggestion if applicable)
    const commentRepo = new CommentRepository(db);
    const result = await commentRepo.deleteComment(commentId);

    res.json({
      success: true,
      message: 'File-level comment deleted successfully',
      dismissedSuggestionId: result.dismissedSuggestionId
    });

  } catch (error) {
    logger.error('Error deleting file-level comment:', error);
    res.status(500).json({
      error: 'Failed to delete comment'
    });
  }
});

/**
 * Update AI suggestion status for a local review
 * Sets status to 'adopted', 'dismissed', or 'active' (restored)
 */
router.post('/api/local/:reviewId/ai-suggestion/:suggestionId/status', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const suggestionId = parseInt(req.params.suggestionId);
    const { status } = req.body;

    if (isNaN(reviewId) || reviewId <= 0) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (isNaN(suggestionId) || suggestionId <= 0) {
      return res.status(400).json({
        error: 'Invalid suggestion ID'
      });
    }

    if (!['adopted', 'dismissed', 'active'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Must be "adopted", "dismissed", or "active"'
      });
    }

    const db = req.app.get('db');
    const commentRepo = new CommentRepository(db);

    // Get the suggestion and verify it belongs to this review
    const suggestion = await commentRepo.getComment(suggestionId, 'ai');

    if (!suggestion) {
      return res.status(404).json({
        error: 'AI suggestion not found'
      });
    }

    if (suggestion.review_id !== reviewId) {
      return res.status(403).json({
        error: 'Suggestion does not belong to this review'
      });
    }

    // Update suggestion status using repository
    await commentRepo.updateSuggestionStatus(suggestionId, status);

    res.json({
      success: true,
      status
    });

  } catch (error) {
    logger.error('Error updating AI suggestion status:', error);
    res.status(500).json({
      error: error.message || 'Failed to update suggestion status'
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
    logger.error('Error fetching local review user comment:', error);
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
    logger.error('Error updating local review user comment:', error);
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
    logger.error('Error deleting all local review user comments:', error);
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
    logger.error('Error deleting local review user comment:', error);
    res.status(500).json({
      error: 'Failed to delete comment'
    });
  }
});

/**
 * Restore a dismissed user comment in a local review
 * Sets status from 'inactive' back to 'active'
 */
router.put('/api/local/:reviewId/user-comments/:commentId/restore', async (req, res) => {
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

    if (comment.status !== 'inactive') {
      return res.status(400).json({
        error: 'Comment is not dismissed'
      });
    }

    // Restore the comment using CommentRepository
    const commentRepo = new CommentRepository(db);
    await commentRepo.restoreComment(commentId);

    // Get the restored comment to return
    const restoredComment = await commentRepo.getComment(commentId, 'user');

    res.json({
      success: true,
      message: 'Comment restored successfully',
      comment: restoredComment
    });

  } catch (error) {
    logger.error('Error restoring local review user comment:', error);
    res.status(500).json({
      error: error.message || 'Failed to restore comment'
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

    if (analysisId) {
      const analysis = activeAnalyses.get(analysisId);

      if (analysis) {
        return res.json({
          running: true,
          analysisId,
          status: analysis
        });
      }

      // Clean up stale mapping
      localReviewToAnalysisId.delete(reviewKey);
    }

    // Fall back to database — an analysis may have been started externally (e.g. via MCP)
    const db = req.app.get('db');
    const analysisRunRepo = new AnalysisRunRepository(db);
    const latestRun = await analysisRunRepo.getLatestByReviewId(reviewId);

    if (latestRun && latestRun.status === 'running') {
      return res.json({
        running: true,
        analysisId: latestRun.id,
        status: {
          id: latestRun.id,
          reviewId,
          reviewType: 'local',
          status: 'running',
          startedAt: latestRun.started_at,
          progress: 'Analysis in progress...',
          levels: {
            1: { status: 'running', progress: 'Running...' },
            2: { status: 'running', progress: 'Running...' },
            3: { status: 'running', progress: 'Running...' },
            4: { status: 'pending', progress: 'Pending' }
          },
          filesAnalyzed: latestRun.files_analyzed || 0,
          filesRemaining: 0
        }
      });
    }

    res.json({
      running: false,
      analysisId: null,
      status: null
    });

  } catch (error) {
    logger.error('Error checking local review analysis status:', error);
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
    const { runId } = req.query;

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
    // Exclude raw council voice suggestions (is_raw=1) — only count final/consolidated suggestions
    const result = await queryOne(db, `
      SELECT EXISTS(
        SELECT 1 FROM comments
        WHERE review_id = ? AND source = 'ai' AND (is_raw = 0 OR is_raw IS NULL)
      ) as has_suggestions
    `, [reviewId]);

    const hasSuggestions = result?.has_suggestions === 1;

    // Check if any analysis has been run using analysis_runs table
    let analysisHasRun = hasSuggestions;
    const analysisRunRepo = new AnalysisRunRepository(db);
    let selectedRun = null;
    try {
      // If runId is provided, fetch that specific run; otherwise get the latest
      if (runId) {
        selectedRun = await analysisRunRepo.getById(runId);
      } else {
        selectedRun = await analysisRunRepo.getLatestByReviewId(reviewId);
      }
      analysisHasRun = !!(selectedRun || hasSuggestions);
    } catch (e) {
      // Log the error at debug level before falling back
      logger.debug('analysis_runs query failed in local mode, falling back to hasSuggestions:', e.message);
      // Fall back to using hasSuggestions if analysis_runs table doesn't exist
      analysisHasRun = hasSuggestions;
    }

    // Get AI summary from the selected analysis run if available, otherwise fall back to review summary
    const summary = selectedRun?.summary || review?.summary || null;

    // Get stats for AI suggestions (issues/suggestions/praise for final level only)
    // Filter by runId if provided, otherwise use the latest analysis run
    let stats = { issues: 0, suggestions: 0, praise: 0 };
    if (hasSuggestions) {
      try {
        const statsQuery = getStatsQuery(runId);
        const statsResult = await query(db, statsQuery.query, statsQuery.params(reviewId));
        stats = calculateStats(statsResult);
      } catch (e) {
        logger.warn('Error fetching AI suggestion stats:', e);
      }
    }

    res.json({
      hasSuggestions: hasSuggestions,
      analysisHasRun: analysisHasRun,
      summary: summary,
      stats: stats
    });

  } catch (error) {
    logger.error('Error checking for AI suggestions:', error);
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

    // Persist diff to database for future session recovery
    try {
      await reviewRepo.saveLocalDiff(targetSessionId, { diff, stats, digest });
    } catch (persistError) {
      logger.warn(`Could not persist diff to database: ${persistError.message}`);
    }

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
    logger.error('Error refreshing local diff:', error);
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
        custom_instructions: null,
        last_council_id: null
      });
    }

    // Find the last council used for this review
    let last_council_id = null;
    const lastCouncilRun = await queryOne(db, `
      SELECT model FROM analysis_runs
      WHERE review_id = ? AND provider = 'council' AND model != 'inline-config'
      ORDER BY started_at DESC LIMIT 1
    `, [review.id]);
    if (lastCouncilRun) {
      last_council_id = lastCouncilRun.model;
    }

    res.json({
      custom_instructions: review.custom_instructions || null,
      last_council_id
    });

  } catch (error) {
    logger.error('Error fetching local review settings:', error);
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
    logger.error('Error saving local review settings:', error);
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

    res.json({ runs: runs.map(r => ({
      ...r,
      levels_config: r.levels_config ? JSON.parse(r.levels_config) : null
    })) });
  } catch (error) {
    logger.error('Error fetching analysis runs:', error);
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
    logger.error('Error fetching latest analysis run:', error);
    res.status(500).json({ error: 'Failed to fetch latest analysis run' });
  }
});

// ============================================================================
// CHAT ROUTES (Local Mode)
// ============================================================================

// Store active SSE clients for each chat session (local mode)
const localChatStreamClients = new Map();

/**
 * Start a new chat session about a comment (Local Mode)
 * POST /api/local/:reviewId/chat/start
 * Body: { commentId, provider?, model? }
 */
router.post('/api/local/:reviewId/chat/start', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const { commentId, provider, model } = req.body;

    if (isNaN(reviewId)) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (!commentId) {
      return res.status(400).json({
        error: 'commentId is required'
      });
    }

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);
    const commentRepo = new CommentRepository(db);
    const analysisRunRepo = new AnalysisRunRepository(db);

    // Get the comment to verify it belongs to this review
    const comment = await commentRepo.getCommentById(commentId);
    if (!comment) {
      return res.status(404).json({
        error: 'Comment not found'
      });
    }

    if (comment.review_id !== reviewId) {
      return res.status(400).json({
        error: 'Comment does not belong to this review'
      });
    }

    // Get the review to find the local path
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
    if (!review) {
      return res.status(404).json({
        error: 'Review not found'
      });
    }

    if (review.review_type !== 'local') {
      return res.status(400).json({
        error: 'Review is not a local review'
      });
    }

    // For local mode, the worktree path is the local_path
    const worktreePath = review.local_path;
    if (!worktreePath) {
      return res.status(400).json({
        error: 'No local path found for this review'
      });
    }

    // Create the chat service
    const chatService = new ChatService(db, chatRepo, commentRepo, analysisRunRepo);

    // Start the session
    const session = await chatService.startChatSession(
      commentId,
      worktreePath,
      { provider, model }
    );

    logger.info(`Local chat session started: ${session.id} for comment ${commentId}`);

    res.json({
      success: true,
      chatId: session.id,
      provider: session.provider,
      model: session.model,
      comment: session.comment
    });

  } catch (error) {
    logger.error('Error starting local chat session:', error);
    res.status(500).json({
      error: error.message || 'Failed to start chat session'
    });
  }
});

/**
 * Send a message in a chat session (Local Mode)
 * POST /api/local/:reviewId/chat/:chatId/message
 * Body: { content }
 */
router.post('/api/local/:reviewId/chat/:chatId/message', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const { chatId } = req.params;
    const { content } = req.body;

    if (isNaN(reviewId)) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({
        error: 'Message content is required'
      });
    }

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);
    const commentRepo = new CommentRepository(db);
    const analysisRunRepo = new AnalysisRunRepository(db);

    // Get session
    const session = await chatRepo.getSession(chatId);
    if (!session) {
      return res.status(404).json({
        error: 'Chat session not found'
      });
    }

    // Get the comment to verify review ID
    const comment = await commentRepo.getCommentById(session.comment_id);
    if (!comment) {
      return res.status(404).json({
        error: 'Comment not found'
      });
    }

    if (comment.review_id !== reviewId) {
      return res.status(400).json({
        error: 'Comment does not belong to this review'
      });
    }

    // Get the review for local path
    const review = await queryOne(db, 'SELECT * FROM reviews WHERE id = ?', [reviewId]);
    if (!review) {
      return res.status(404).json({
        error: 'Review not found'
      });
    }

    const worktreePath = review.local_path;
    if (!worktreePath) {
      return res.status(400).json({
        error: 'No local path found for this review'
      });
    }

    // Create the chat service
    const chatService = new ChatService(db, chatRepo, commentRepo, analysisRunRepo);

    // Send the message (will stream to SSE clients if any are connected)
    const clients = localChatStreamClients.get(chatId) || new Set();

    let streamedResponse = '';
    const result = await chatService.sendMessage(
      chatId,
      content,
      worktreePath,
      {
        onStreamEvent: (event) => {
          // Stream to all connected SSE clients
          if (event.type === 'assistant_text' && event.text) {
            streamedResponse += event.text;
            clients.forEach(client => {
              if (!client.closed) {
                client.write(`data: ${JSON.stringify({ type: 'chunk', content: event.text })}\n\n`);
              }
            });
          }
        }
      }
    );

    // Send completion event to SSE clients
    clients.forEach(client => {
      if (!client.closed) {
        client.write(`data: ${JSON.stringify({ type: 'done', messageId: result.messageId })}\n\n`);
      }
    });

    logger.info(`Local chat message sent in session ${chatId}`);

    res.json({
      success: true,
      messageId: result.messageId,
      response: result.response
    });

  } catch (error) {
    logger.error('Error sending local chat message:', error);

    // Send error event to SSE clients
    const clients = localChatStreamClients.get(req.params.chatId) || new Set();
    clients.forEach(client => {
      if (!client.closed) {
        client.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      }
    });

    res.status(500).json({
      error: error.message || 'Failed to send message'
    });
  }
});

/**
 * Get messages for a chat session (Local Mode)
 * GET /api/local/:reviewId/chat/:chatId/messages
 */
router.get('/api/local/:reviewId/chat/:chatId/messages', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const { chatId } = req.params;

    if (isNaN(reviewId)) {
      return res.status(400).json({
        error: 'Invalid review ID'
      });
    }

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);

    const sessionWithMessages = await chatRepo.getSessionWithMessages(chatId);

    if (!sessionWithMessages) {
      return res.status(404).json({
        error: 'Chat session not found'
      });
    }

    // Verify session belongs to this review
    const commentRepo = new CommentRepository(db);
    const comment = await commentRepo.getCommentById(sessionWithMessages.comment_id);
    if (comment && comment.review_id !== reviewId) {
      return res.status(400).json({
        error: 'Chat session does not belong to this review'
      });
    }

    res.json({
      success: true,
      session: sessionWithMessages
    });

  } catch (error) {
    logger.error('Error fetching local chat messages:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch messages'
    });
  }
});

/**
 * Server-Sent Events (SSE) stream for chat responses (Local Mode)
 * GET /api/local/:reviewId/chat/:chatId/stream
 */
router.get('/api/local/:reviewId/chat/:chatId/stream', async (req, res) => {
  const reviewId = parseInt(req.params.reviewId);
  const { chatId } = req.params;

  if (isNaN(reviewId)) {
    return res.status(400).json({
      error: 'Invalid review ID'
    });
  }

  try {
    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);

    // Verify session exists
    const session = await chatRepo.getSession(chatId);
    if (!session) {
      return res.status(404).json({
        error: 'Chat session not found'
      });
    }

    // Verify session belongs to this review
    const commentRepo = new CommentRepository(db);
    const comment = await commentRepo.getCommentById(session.comment_id);
    if (comment && comment.review_id !== reviewId) {
      return res.status(400).json({
        error: 'Chat session does not belong to this review'
      });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add this client to the set for this chat session
    if (!localChatStreamClients.has(chatId)) {
      localChatStreamClients.set(chatId, new Set());
    }
    localChatStreamClients.get(chatId).add(res);

    logger.info(`Local SSE client connected for chat session ${chatId}`);

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', chatId })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      const clients = localChatStreamClients.get(chatId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          localChatStreamClients.delete(chatId);
        }
      }
      logger.info(`Local SSE client disconnected from chat session ${chatId}`);
    });

  } catch (error) {
    logger.error('Error setting up local SSE stream:', error);
    res.status(500).json({
      error: error.message || 'Failed to set up stream'
    });
  }
});

/**
 * Get all chat sessions for a comment (Local Mode)
 * GET /api/local/:reviewId/chat/comment/:commentId/sessions
 */
router.get('/api/local/:reviewId/chat/comment/:commentId/sessions', async (req, res) => {
  try {
    const reviewId = parseInt(req.params.reviewId);
    const commentId = parseInt(req.params.commentId);

    if (isNaN(reviewId) || isNaN(commentId)) {
      return res.status(400).json({
        error: 'Invalid review ID or comment ID'
      });
    }

    const db = req.app.get('db');
    const chatRepo = new ChatRepository(db);
    const commentRepo = new CommentRepository(db);

    // Verify comment exists and belongs to this review
    const comment = await commentRepo.getCommentById(commentId);
    if (!comment) {
      return res.status(404).json({
        error: 'Comment not found'
      });
    }

    if (comment.review_id !== reviewId) {
      return res.status(400).json({
        error: 'Comment does not belong to this review'
      });
    }

    const sessions = await chatRepo.getSessionsByComment(commentId);

    res.json({
      success: true,
      sessions
    });

  } catch (error) {
    logger.error('Error fetching local chat sessions:', error);
    res.status(500).json({
      error: error.message || 'Failed to fetch chat sessions'
    });
  }
});

module.exports = router;
