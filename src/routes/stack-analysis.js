// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stack Analysis Routes & Orchestrator
 *
 * Provides endpoints for analyzing a Graphite stack of PRs sequentially:
 * - POST /api/pr/:owner/:repo/:number/analyses/stack — start stack analysis
 * - GET  /api/analyses/stack/:stackAnalysisId        — get stack analysis status
 * - POST /api/analyses/stack/:stackAnalysisId/cancel  — cancel stack analysis
 *
 * The orchestrator checks out each PR's branch in the shared worktree,
 * runs the configured analysis (single, council, or executable), awaits
 * completion, then moves to the next PR (bottom-up order).
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const logger = require('../utils/logger');
const { normalizeRepository } = require('../utils/paths');
const { mergeInstructions } = require('../utils/instructions');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { getGitHubToken } = require('../config');
const { worktreeLock } = require('../git/worktree-lock');
const { setupStackPR } = require('../setup/stack-setup');
const Analyzer = require('../ai/analyzer');
const { getProviderClass, createProvider } = require('../ai/provider');
const { VALID_TIERS, resolveTier } = require('../ai/prompts/config');
const { validateCouncilConfig, normalizeCouncilConfig } = require('./councils');
const ws = require('../ws');
const {
  query,
  queryOne,
  WorktreeRepository,
  ReviewRepository,
  RepoSettingsRepository,
  AnalysisRunRepository,
  PRMetadataRepository,
  CouncilRepository
} = require('../database');
const {
  activeAnalyses,
  reviewToAnalysisId,
  getModel,
  determineCompletionInfo,
  broadcastProgress,
  createProgressCallback,
  parseEnabledLevels,
  registerProcess: registerProcessForCancellation,
  killProcesses
} = require('./shared');
const { broadcastReviewEvent } = require('../events/review-events');
const analysesRouter = require('./analyses');
const { runExecutableAnalysis } = require('./executable-analysis');

const router = express.Router();

// In-memory tracking for active stack analyses
const activeStackAnalyses = new Map();

// ============================================================================
// Helper: wait for an individual analysis to reach a terminal state
// ============================================================================

/**
 * Poll activeAnalyses until the given analysisId reaches a terminal state.
 * @param {string} analysisId
 * @param {number} [timeoutMs=600000] - Maximum wait time (default 10 min)
 * @returns {Promise<Object>} Terminal analysis status
 */
function waitForAnalysisCompletion(analysisId, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const status = activeAnalyses.get(analysisId);
      if (!status) {
        // Entry was cleaned up — treat as completed
        resolve({ status: 'completed', id: analysisId });
        return;
      }
      if (['completed', 'failed', 'cancelled'].includes(status.status)) {
        resolve(status);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Analysis ${analysisId} timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

// ============================================================================
// Helper: broadcast stack progress
// ============================================================================

function broadcastStackProgress(stackAnalysisId, state) {
  const prStatuses = [];
  for (const [prNum, prStatus] of state.prStatuses) {
    prStatuses.push({ prNumber: prNum, ...prStatus });
  }

  ws.broadcast(`stack-analysis:${stackAnalysisId}`, {
    type: 'stack-progress',
    stackAnalysisId,
    status: state.status,
    currentPRNumber: state.currentPRNumber,
    currentPRIndex: state.currentPRIndex,
    totalPRs: state.totalPRs,
    prStatuses
  });
}

// ============================================================================
// Core: execute stack analysis (runs in background)
// ============================================================================

const defaults = {
  execSync,
  GitWorktreeManager,
  GitHubClient,
  getGitHubToken,
  setupStackPR,
  Analyzer,
  getProviderClass,
  createProvider,
  launchCouncilAnalysis: analysesRouter.launchCouncilAnalysis,
  runExecutableAnalysis,
  waitForAnalysisCompletion
};

/**
 * Execute sequential stack analysis across multiple PRs.
 *
 * @param {Object} params
 * @param {Object} params.db - Database handle
 * @param {Object} params.config - Application config
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.repository - Normalized owner/repo
 * @param {number} params.triggerPRNumber - The PR that triggered the stack analysis
 * @param {string} params.worktreePath - Shared worktree path
 * @param {number[]} params.prNumbers - PR numbers to analyze (bottom-up order)
 * @param {Object} params.analysisConfig - Analysis configuration from request
 * @param {string} params.stackAnalysisId - Unique ID for this stack analysis
 * @param {Object} [params._deps] - Dependency overrides for testing
 */
async function executeStackAnalysis(params) {
  const {
    db, config, owner, repo, repository, triggerPRNumber,
    worktreePath, prNumbers, analysisConfig, stackAnalysisId,
    _deps
  } = params;

  const deps = { ...defaults, ..._deps };

  const state = activeStackAnalyses.get(stackAnalysisId);
  if (!state) return;

  let originalHead = null;
  let originalBranch = null;

  // Snapshot existing worktree records for hazard #1 mitigation
  const worktreeRepo = new WorktreeRepository(db);
  const originalWorktreeRecords = new Map();

  try {
    // 1. Acquire lock
    const acquired = worktreeLock.acquire(worktreePath, stackAnalysisId);
    if (!acquired) {
      state.status = 'failed';
      state.error = 'Worktree is already locked by another operation';
      activeStackAnalyses.set(stackAnalysisId, state);
      broadcastStackProgress(stackAnalysisId, state);
      return;
    }

    // 2. Record original HEAD + branch
    try {
      originalHead = deps.execSync('git rev-parse HEAD', {
        cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      originalBranch = deps.execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch (e) {
      logger.warn(`Could not record original HEAD: ${e.message}`);
    }

    // Snapshot worktree records for selected PRs (hazard #1)
    for (const prNum of prNumbers) {
      const wt = await worktreeRepo.findByPR(prNum, repository);
      if (wt) {
        originalWorktreeRecords.set(prNum, { ...wt });
      }
    }

    // 3. Bulk fetch GitHub data for all selected PRs
    const githubToken = deps.getGitHubToken(config);
    let githubClient = null;
    if (githubToken) {
      githubClient = new deps.GitHubClient(githubToken);
    }

    // 4. Git fetch all PR refs in a single command
    const refspecs = prNumbers.map(n => `+refs/pull/${n}/head:refs/remotes/origin/pr-${n}`);
    try {
      deps.execSync(`git fetch origin ${refspecs.join(' ')}`, {
        cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000
      });
    } catch (fetchError) {
      logger.warn(`Bulk git fetch failed, will fetch per-PR: ${fetchError.message}`);
    }

    // 5. For each PR (bottom-up order)
    const worktreeManager = new deps.GitWorktreeManager(db);

    for (let i = 0; i < prNumbers.length; i++) {
      const prNum = prNumbers[i];

      // Check for cancellation
      if (state.cancelled) {
        logger.info(`Stack analysis ${stackAnalysisId} cancelled, stopping at PR #${prNum}`);
        break;
      }

      state.currentPRNumber = prNum;
      state.currentPRIndex = i;
      state.prStatuses.set(prNum, { status: 'running' });
      broadcastStackProgress(stackAnalysisId, state);

      try {
        // 5a. Checkout branch
        logger.info(`Stack analysis: checking out PR #${prNum}`);
        await worktreeManager.checkoutBranch(worktreePath, prNum);

        // 5b. Setup PR (creates/updates metadata, review, worktree records)
        logger.info(`Stack analysis: setting up PR #${prNum}`);
        const githubToken = deps.getGitHubToken(config);
        await deps.setupStackPR({
          db, owner, repo, prNumber: prNum,
          githubToken, worktreePath, worktreeManager
        });

        // Fetch the full prMetadata from DB (includes id, head_sha, base_sha, etc.)
        const prMetadataRepo = new PRMetadataRepository(db);
        const prMetadata = await prMetadataRepo.getByPR(prNum, repository);
        if (!prMetadata) {
          throw new Error(`PR metadata not found for PR #${prNum} after setup`);
        }

        const reviewRepo = new ReviewRepository(db);
        const { review } = await reviewRepo.getOrCreate({ prNumber: prNum, repository });
        const reviewId = review.id;

        // 5c. Resolve analysis config
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
        const repoInstructions = repoSettings?.default_instructions || null;
        const globalInstructions = config.globalInstructions || null;
        const requestInstructions = analysisConfig.customInstructions || null;

        const {
          configType = 'single', provider: reqProvider, model: reqModel,
          tier: reqTier, enabledLevels: reqEnabledLevels,
          isCouncil, councilId, councilConfig: rawCouncilConfig
        } = analysisConfig;

        // 5d. Launch analysis based on config type
        let analysisResult;

        if (configType === 'council' || configType === 'advanced' || isCouncil) {
          analysisResult = await launchStackCouncilAnalysis(deps, db, config, {
            reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
            globalInstructions, repoInstructions, requestInstructions,
            councilId, rawCouncilConfig, configType
          });
        } else {
          // Resolve provider/model
          let selectedProvider = reqProvider || repoSettings?.default_provider || config.default_provider || config.provider || 'claude';
          let selectedModel = reqModel || repoSettings?.default_model || config.default_model || config.model || 'opus';

          const ProviderClass = deps.getProviderClass(selectedProvider);

          if (ProviderClass?.isExecutable) {
            analysisResult = await launchStackExecutableAnalysis(deps, db, config, {
              reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
              selectedProvider, selectedModel,
              repoInstructions, requestInstructions
            });
          } else {
            analysisResult = await launchStackSingleAnalysis(deps, db, config, {
              reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
              selectedProvider, selectedModel,
              globalInstructions, repoInstructions, requestInstructions,
              reqTier, reqEnabledLevels
            });
          }
        }

        // 5e. Record result
        state.prStatuses.set(prNum, {
          status: analysisResult.status === 'completed' ? 'completed' : 'failed',
          analysisId: analysisResult.analysisId,
          suggestionsCount: analysisResult.suggestionsCount || 0,
          error: analysisResult.error || null
        });
        broadcastStackProgress(stackAnalysisId, state);

      } catch (prError) {
        // 5f. On error: log, mark failed, continue
        logger.error(`Stack analysis: PR #${prNum} failed: ${prError.message}`);
        state.prStatuses.set(prNum, {
          status: 'failed',
          error: prError.message
        });
        broadcastStackProgress(stackAnalysisId, state);
      }
    }

    // Set final status
    state.status = state.cancelled ? 'cancelled' : 'completed';
    state.completedAt = new Date().toISOString();

  } catch (outerError) {
    logger.error(`Stack analysis ${stackAnalysisId} failed: ${outerError.message}`);
    state.status = 'failed';
    state.error = outerError.message;
  } finally {
    // 6. Restore original branch
    if (originalHead) {
      try {
        if (originalBranch && originalBranch !== 'HEAD') {
          deps.execSync(`git checkout ${originalBranch}`, {
            cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
          });
        } else {
          deps.execSync(`git reset --hard ${originalHead}`, {
            cwd: worktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
          });
        }
      } catch (restoreError) {
        logger.warn(`Failed to restore original branch: ${restoreError.message}`);
      }
    }

    // Hazard #1 mitigation: restore worktree records for PRs that had different paths
    for (const [prNum, original] of originalWorktreeRecords) {
      try {
        const current = await worktreeRepo.findByPR(prNum, repository);
        if (current && current.path !== original.path) {
          await worktreeRepo.updatePath(current.id, original.path);
          logger.info(`Restored worktree path for PR #${prNum} to ${original.path}`);
        }
      } catch (restoreError) {
        logger.warn(`Failed to restore worktree path for PR #${prNum}: ${restoreError.message}`);
      }
    }

    // 7. Release lock
    worktreeLock.release(worktreePath, stackAnalysisId);

    // 8. Broadcast completion
    activeStackAnalyses.set(stackAnalysisId, state);
    broadcastStackProgress(stackAnalysisId, state);
  }
}

// ============================================================================
// Analysis launchers (per type)
// ============================================================================

/**
 * Launch single-model analysis for a stack PR and await completion.
 */
async function launchStackSingleAnalysis(deps, db, config, {
  reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
  selectedProvider, selectedModel,
  globalInstructions, repoInstructions, requestInstructions,
  reqTier, reqEnabledLevels
}) {
  const runId = uuidv4();
  const analysisId = runId;
  const tier = reqTier ? resolveTier(reqTier) : 'balanced';
  const levelsConfig = parseEnabledLevels(reqEnabledLevels);

  const analysisRunRepo = new AnalysisRunRepository(db);
  await analysisRunRepo.create({
    id: runId,
    reviewId,
    provider: selectedProvider,
    model: selectedModel,
    tier,
    globalInstructions,
    repoInstructions,
    requestInstructions,
    headSha: prMetadata.head_sha || null,
    configType: 'single',
    levelsConfig
  });

  const initialStatus = {
    id: analysisId,
    runId,
    reviewId,
    prNumber: prNum,
    repository,
    reviewType: 'pr',
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
  reviewToAnalysisId.set(reviewId, analysisId);
  broadcastProgress(analysisId, initialStatus);
  broadcastReviewEvent(reviewId, { type: 'review:analysis_started', analysisId });

  const analyzer = new deps.Analyzer(db, selectedModel, selectedProvider);
  const progressCallback = createProgressCallback(analysisId);

  logger.info(`Stack analysis: starting single-model analysis for PR #${prNum} (${selectedProvider}/${selectedModel})`);

  try {
    const result = await analyzer.analyzeLevel1(
      reviewId, worktreePath, prMetadata, progressCallback,
      { globalInstructions, repoInstructions, requestInstructions },
      null,
      { analysisId, runId, skipRunCreation: true, tier, enabledLevels: levelsConfig }
    );

    const completionInfo = determineCompletionInfo(result);

    const currentStatus = activeAnalyses.get(analysisId);
    if (currentStatus && currentStatus.status !== 'cancelled') {
      for (let lvl = 1; lvl <= completionInfo.completedLevel; lvl++) {
        currentStatus.levels[lvl] = { status: 'completed', progress: `Level ${lvl} complete` };
      }
      currentStatus.levels[4] = { status: 'completed', progress: 'Results finalized' };
      const completedStatus = {
        ...currentStatus,
        status: 'completed',
        completedAt: new Date().toISOString(),
        progress: completionInfo.progressMessage,
        suggestionsCount: completionInfo.totalSuggestions
      };
      activeAnalyses.set(analysisId, completedStatus);
      broadcastProgress(analysisId, completedStatus);
      broadcastReviewEvent(reviewId, { type: 'review:analysis_completed' });
    }

    // Update pr_metadata with last_ai_run_id
    try {
      const prMetadataRepo = new PRMetadataRepository(db);
      await prMetadataRepo.updateLastAiRunId(prMetadata.id, runId);
    } catch (e) {
      logger.warn(`Failed to update pr_metadata: ${e.message}`);
    }

    return {
      analysisId, runId, status: 'completed',
      suggestionsCount: completionInfo.totalSuggestions
    };
  } catch (error) {
    if (error.isCancellation) {
      return { analysisId, runId, status: 'cancelled', suggestionsCount: 0 };
    }

    logger.error(`Stack single analysis failed for PR #${prNum}: ${error.message}`);
    const currentStatus = activeAnalyses.get(analysisId);
    if (currentStatus) {
      const failedStatus = {
        ...currentStatus,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message,
        progress: 'Analysis failed'
      };
      activeAnalyses.set(analysisId, failedStatus);
      broadcastProgress(analysisId, failedStatus);
    }

    return { analysisId, runId, status: 'failed', error: error.message, suggestionsCount: 0 };
  } finally {
    reviewToAnalysisId.delete(reviewId);
  }
}

/**
 * Launch council analysis for a stack PR and await completion.
 */
async function launchStackCouncilAnalysis(deps, db, config, {
  reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
  globalInstructions, repoInstructions, requestInstructions,
  councilId, rawCouncilConfig, configType
}) {
  let councilConfig;
  let resolvedConfigType = configType;

  if (councilId) {
    const councilRepo = new CouncilRepository(db);
    const council = await councilRepo.getById(councilId);
    if (!council) {
      throw new Error(`Council ${councilId} not found`);
    }
    councilConfig = council.config;
    resolvedConfigType = configType || council.type || 'advanced';
  } else if (rawCouncilConfig) {
    councilConfig = rawCouncilConfig;
  } else {
    throw new Error('Council analysis requires councilId or councilConfig');
  }

  councilConfig = normalizeCouncilConfig(councilConfig, resolvedConfigType);
  const configError = validateCouncilConfig(councilConfig, resolvedConfigType);
  if (configError) {
    throw new Error(`Invalid council config: ${configError}`);
  }

  const reviewRepo = new ReviewRepository(db);
  const { review } = await reviewRepo.getOrCreate({ prNumber: prNum, repository });

  logger.info(`Stack analysis: starting council analysis for PR #${prNum}`);

  const { analysisId, runId } = await deps.launchCouncilAnalysis(
    db,
    {
      reviewId: review.id,
      worktreePath,
      prMetadata,
      changedFiles: null,
      repository,
      headSha: prMetadata.head_sha,
      logLabel: `Stack PR #${prNum}`,
      initialStatusExtra: { prNumber: prNum, reviewType: 'pr' },
      config,
      hookContext: {
        mode: 'pr',
        prContext: {
          number: prNum, owner, repo,
          author: prMetadata.author, baseBranch: prMetadata.base_branch,
          headBranch: prMetadata.head_branch,
          baseSha: prMetadata.base_sha || null, headSha: prMetadata.head_sha || null,
        },
      },
      onSuccess: async (result) => {
        if (result.summary) {
          await reviewRepo.upsertSummary(prNum, repository, result.summary);
        }
      }
    },
    councilConfig,
    councilId,
    { globalInstructions, repoInstructions, requestInstructions },
    resolvedConfigType
  );

  // Wait for completion
  const finalStatus = await deps.waitForAnalysisCompletion(analysisId);

  return {
    analysisId,
    runId,
    status: finalStatus.status,
    suggestionsCount: finalStatus.suggestionsCount || 0,
    error: finalStatus.error || null
  };
}

/**
 * Launch executable provider analysis for a stack PR and await completion.
 */
async function launchStackExecutableAnalysis(deps, db, config, {
  reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
  selectedProvider, selectedModel,
  repoInstructions, requestInstructions
}) {
  const runId = uuidv4();
  const analysisId = runId;

  const reviewRepo = new ReviewRepository(db);
  const { review } = await reviewRepo.getOrCreate({ prNumber: prNum, repository });

  logger.info(`Stack analysis: starting executable analysis for PR #${prNum} (${selectedProvider})`);

  // Create a minimal req/res adapter for runExecutableAnalysis
  const fakeReq = {
    app: {
      get: (key) => {
        if (key === 'db') return db;
        if (key === 'config') return config;
        if (key === 'githubToken') return deps.getGitHubToken(config);
        return null;
      }
    }
  };
  // Capture the early response but don't actually send HTTP
  let responded = false;
  const fakeRes = {
    json: () => { responded = true; },
    status: () => ({ json: () => { responded = true; } })
  };

  const prContext = {
    number: prNum, owner, repo,
    author: prMetadata.author, baseBranch: prMetadata.base_branch,
    headBranch: prMetadata.head_branch,
    baseSha: prMetadata.base_sha || null, headSha: prMetadata.head_sha || null,
  };

  await deps.runExecutableAnalysis(fakeReq, fakeRes, {
    reviewId: review.id,
    review,
    selectedProvider,
    selectedModel,
    repoInstructions,
    requestInstructions,
    runId,
    analysisId,
    repository,
    reviewType: 'pr',
    headSha: prMetadata.head_sha,
    extraInitialStatus: { prNumber: prNum }
  }, {
    activeAnalyses,
    reviewToAnalysisId,
    broadcastProgress,
    broadcastReviewEvent,
    registerProcessForCancellation
  }, {
    logLabel: `Stack PR #${prNum}`,
    buildContext: (_r, { selectedModel: model, requestInstructions: customInstructions }) => ({
      title: prMetadata.title || `PR #${prNum}`,
      description: prMetadata.description || '',
      cwd: worktreePath,
      model,
      baseSha: prMetadata.base_sha || null,
      headSha: prMetadata.head_sha || null,
      baseBranch: prMetadata.base_branch || null,
      headBranch: prMetadata.head_branch || null,
      customInstructions: customInstructions || null
    }),
    buildHookPayload: () => ({ mode: 'pr', prContext }),
    onSuccess: async (_db, _runId, { summary }) => {
      const prMetadataRepo = new PRMetadataRepository(db);
      try {
        await prMetadataRepo.updateLastAiRunId(prMetadata.id, _runId);
      } catch (e) {
        logger.warn(`Failed to update pr_metadata: ${e.message}`);
      }
      if (summary) {
        try {
          await reviewRepo.upsertSummary(prNum, repository, summary);
        } catch (e) {
          logger.warn(`Failed to save summary: ${e.message}`);
        }
      }
    }
  });

  // Wait for completion
  const finalStatus = await deps.waitForAnalysisCompletion(analysisId);

  return {
    analysisId,
    runId,
    status: finalStatus.status,
    suggestionsCount: finalStatus.suggestionsCount || 0,
    error: finalStatus.error || null
  };
}

// ============================================================================
// Endpoints
// ============================================================================

/**
 * Start a stack analysis across multiple PRs.
 */
router.post('/api/pr/:owner/:repo/:number/analyses/stack', async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const prNumber = parseInt(number);

    if (isNaN(prNumber) || prNumber <= 0) {
      return res.status(400).json({ error: 'Invalid pull request number' });
    }

    const { prNumbers, analysisConfig } = req.body || {};

    if (!Array.isArray(prNumbers) || prNumbers.length === 0) {
      return res.status(400).json({ error: 'prNumbers must be a non-empty array' });
    }

    if (!analysisConfig) {
      return res.status(400).json({ error: 'analysisConfig is required' });
    }

    // Validate all PR numbers
    for (const n of prNumbers) {
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: `Invalid PR number: ${n}` });
      }
    }

    const repository = normalizeRepository(owner, repo);
    const db = req.app.get('db');
    const config = req.app.get('config') || {};

    // Find worktree path from the triggering PR
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.getWorktreePath({ owner, repo, number: prNumber });

    if (!worktreePath) {
      return res.status(404).json({ error: 'Worktree not found for this PR. Please load the PR first.' });
    }

    // Check lock
    const lockState = worktreeLock.isLocked(worktreePath);
    if (lockState.locked) {
      return res.status(409).json({
        error: 'Worktree is already locked by another operation',
        holderId: lockState.holderId
      });
    }

    const stackAnalysisId = uuidv4();

    // Initialize tracking state
    const prStatuses = new Map();
    for (const n of prNumbers) {
      prStatuses.set(n, { status: 'pending' });
    }

    const state = {
      id: stackAnalysisId,
      status: 'running',
      worktreePath,
      originalBranch: null,
      prStatuses,
      currentPRNumber: null,
      currentPRIndex: null,
      totalPRs: prNumbers.length,
      startedAt: new Date().toISOString(),
      cancelled: false,
      error: null,
      completedAt: null
    };
    activeStackAnalyses.set(stackAnalysisId, state);

    // Start execution in background (don't await)
    executeStackAnalysis({
      db, config, owner, repo, repository,
      triggerPRNumber: prNumber,
      worktreePath, prNumbers, analysisConfig, stackAnalysisId
    }).catch(error => {
      logger.error(`Stack analysis ${stackAnalysisId} uncaught error: ${error.message}`);
    });

    // Respond immediately
    res.json({
      stackAnalysisId,
      status: 'started',
      prAnalyses: prNumbers.map(n => ({ prNumber: n, status: 'pending' }))
    });

  } catch (error) {
    logger.error('Error starting stack analysis:', error);
    res.status(500).json({ error: 'Failed to start stack analysis' });
  }
});

/**
 * Get current state of a stack analysis.
 */
router.get('/api/analyses/stack/:stackAnalysisId', (req, res) => {
  const { stackAnalysisId } = req.params;
  const state = activeStackAnalyses.get(stackAnalysisId);

  if (!state) {
    return res.status(404).json({ error: 'Stack analysis not found' });
  }

  const prStatuses = [];
  for (const [prNum, prStatus] of state.prStatuses) {
    prStatuses.push({ prNumber: prNum, ...prStatus });
  }

  res.json({
    id: state.id,
    status: state.status,
    currentPRNumber: state.currentPRNumber,
    currentPRIndex: state.currentPRIndex,
    totalPRs: state.totalPRs,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    error: state.error,
    prStatuses
  });
});

/**
 * Cancel an active stack analysis.
 */
router.post('/api/analyses/stack/:stackAnalysisId/cancel', (req, res) => {
  const { stackAnalysisId } = req.params;
  const state = activeStackAnalyses.get(stackAnalysisId);

  if (!state) {
    return res.status(404).json({ error: 'Stack analysis not found' });
  }

  if (['completed', 'failed', 'cancelled'].includes(state.status)) {
    return res.json({
      success: true,
      message: `Stack analysis already ${state.status}`,
      status: state.status
    });
  }

  logger.info(`Cancelling stack analysis ${stackAnalysisId}`);

  // Set cancelled flag — the orchestrator loop checks this
  state.cancelled = true;

  // Cancel the currently running individual analysis
  if (state.currentPRNumber) {
    const currentPRStatus = state.prStatuses.get(state.currentPRNumber);
    if (currentPRStatus?.analysisId) {
      // Kill processes for the current analysis
      killProcesses(currentPRStatus.analysisId);
    }
  }

  activeStackAnalyses.set(stackAnalysisId, state);

  res.json({
    success: true,
    message: 'Stack analysis cancellation requested',
    status: 'cancelling'
  });
});

// Export for testing and server mounting
module.exports = router;
module.exports.activeStackAnalyses = activeStackAnalyses;
module.exports.executeStackAnalysis = executeStackAnalysis;
module.exports.waitForAnalysisCompletion = waitForAnalysisCompletion;
