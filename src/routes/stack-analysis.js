// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Stack Analysis Routes & Orchestrator
 *
 * Provides endpoints for analyzing a Graphite stack of PRs in parallel:
 * - POST /api/pr/:owner/:repo/:number/analyses/stack — start stack analysis
 * - GET  /api/analyses/stack/:stackAnalysisId        — get stack analysis status
 * - POST /api/analyses/stack/:stackAnalysisId/cancel  — cancel stack analysis
 *
 * The orchestrator creates per-PR worktrees and runs analyses in parallel,
 * using the configured analysis type (single, council, or executable).
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const logger = require('../utils/logger');
const { normalizeRepository } = require('../utils/paths');
const { mergeInstructions } = require('../utils/instructions');
const { GitWorktreeManager } = require('../git/worktree');
const { GitHubClient } = require('../github/client');
const { getGitHubToken, resolveLoadSkills, buildCouncilProviderOverrides } = require('../config');
const { setupStackPR } = require('../setup/stack-setup');
const Analyzer = require('../ai/analyzer');
const { getProviderClass, createProvider } = require('../ai/provider');
const { VALID_TIERS, resolveTier } = require('../ai/prompts/config');
const { validateCouncilConfig, normalizeCouncilConfig } = require('./councils');
const ws = require('../ws');
const {
  query,
  queryOne,
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
 * Estimate the maximum wall-clock time for a council analysis based on its
 * config.  The real per-call timeouts live inside the analyzer; this is a
 * generous upper bound so the stack orchestrator doesn't give up too early.
 *
 * @param {Object} councilConfig - Resolved council configuration
 * @param {string} configType - 'council' (voice-centric) or 'advanced' (level-centric)
 * @returns {number} Timeout in milliseconds
 */
function estimateCouncilTimeout(councilConfig, configType) {
  const DEFAULT_VOICE_TIMEOUT = 600_000;   // 10 min
  const DEFAULT_CONSOL_TIMEOUT = 300_000;  //  5 min
  const DEFAULT_ORCH_TIMEOUT = 600_000;    // 10 min
  const MARGIN = 120_000;                  //  2 min safety margin

  if (configType === 'council') {
    // Voice-centric: all voices run in parallel, then one consolidation step
    const maxVoiceTimeout = (councilConfig.voices || [])
      .reduce((max, v) => Math.max(max, v.timeout || DEFAULT_VOICE_TIMEOUT), DEFAULT_VOICE_TIMEOUT);
    const consolTimeout = councilConfig.consolidation?.timeout || DEFAULT_CONSOL_TIMEOUT;
    return maxVoiceTimeout + consolTimeout + MARGIN;
  }

  // Level-centric (advanced): per-level voices (parallel) + per-level consolidation,
  // then cross-level orchestration
  const levels = councilConfig.levels || {};
  let levelPhaseTotal = 0;
  for (const lvl of Object.values(levels)) {
    const voices = lvl.voices || [];
    const maxVoice = voices.reduce((max, v) => Math.max(max, v.timeout || DEFAULT_VOICE_TIMEOUT), DEFAULT_VOICE_TIMEOUT);
    const consolTimeout = lvl.consolidation?.timeout || DEFAULT_CONSOL_TIMEOUT;
    levelPhaseTotal += maxVoice + consolTimeout;
  }
  const orchTimeout = (councilConfig.consolidation?.timeout
    || councilConfig.orchestration?.timeout
    || DEFAULT_ORCH_TIMEOUT);
  return levelPhaseTotal + orchTimeout + MARGIN;
}

/**
 * Poll activeAnalyses until the given analysisId reaches a terminal state.
 * @param {string} analysisId
 * @param {number} [timeoutMs=3600000] - Maximum wait time (default 60 min)
 * @returns {Promise<Object>} Terminal analysis status
 */
function waitForAnalysisCompletion(analysisId, timeoutMs = 3_600_000) {
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
  let runningCount = 0;
  let completedCount = 0;
  for (const [prNum, prStatus] of state.prStatuses) {
    prStatuses.push({ prNumber: prNum, ...prStatus });
    if (prStatus.status === 'running') runningCount++;
    if (prStatus.status === 'completed') completedCount++;
  }

  ws.broadcast(`stack-analysis:${stackAnalysisId}`, {
    type: 'stack-progress',
    stackAnalysisId,
    status: state.status,
    currentPRNumber: null,
    currentPRIndex: null,
    runningCount,
    completedCount,
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
 * Execute parallel stack analysis across multiple PRs.
 * Creates per-PR worktrees and runs analyses concurrently.
 *
 * @param {Object} params
 * @param {Object} params.db - Database handle
 * @param {Object} params.config - Application config
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.repository - Normalized owner/repo
 * @param {number} params.triggerPRNumber - The PR that triggered the stack analysis
 * @param {string} params.worktreePath - Trigger PR worktree path (used to resolve repo)
 * @param {number[]} params.prNumbers - PR numbers to analyze (bottom-up order)
 * @param {Object} params.analysisConfig - Analysis configuration from request
 * @param {string} params.stackAnalysisId - Unique ID for this stack analysis
 * @param {Object} [params._deps] - Dependency overrides for testing
 */
async function executeStackAnalysis(params) {
  const {
    db, config, owner, repo, repository, triggerPRNumber,
    worktreePath: triggerWorktreePath, prNumbers, analysisConfig,
    stackAnalysisId, _deps
  } = params;

  const deps = { ...defaults, ..._deps };

  const state = activeStackAnalyses.get(stackAnalysisId);
  if (!state) return;

  try {
    // 1. Resolve repositoryPath from trigger worktree
    const worktreeManager = new deps.GitWorktreeManager(db);
    let repositoryPath;
    try {
      const owningRepoGit = await worktreeManager.resolveOwningRepo(triggerWorktreePath);
      if (owningRepoGit) {
        repositoryPath = (await owningRepoGit.raw(['rev-parse', '--show-toplevel'])).trim();
      }
    } catch (e) {
      logger.warn(`Failed to resolve owning repo for ${triggerWorktreePath}, falling back: ${e.message}`);
      repositoryPath = triggerWorktreePath;
    }
    if (!repositoryPath) repositoryPath = triggerWorktreePath;

    // 2. Bulk fetch all PR refs (runs against trigger worktree)
    const refspecs = prNumbers.map(n => `+refs/pull/${n}/head:refs/remotes/origin/pr-${n}`);
    try {
      deps.execSync(`git fetch origin ${refspecs.join(' ')}`, {
        cwd: triggerWorktreePath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000
      });
    } catch (fetchError) {
      logger.warn(`Bulk git fetch failed, will fetch per-PR: ${fetchError.message}`);
    }

    // 3. Fetch all PR data from GitHub in parallel
    const githubToken = deps.getGitHubToken(config);
    const prDataMap = new Map();
    if (githubToken) {
      const githubClient = new deps.GitHubClient(githubToken);
      const fetchResults = await Promise.allSettled(
        prNumbers.map(async (prNum) => {
          const prData = await githubClient.fetchPullRequest(owner, repo, prNum);
          return { prNum, prData };
        })
      );
      for (const result of fetchResults) {
        if (result.status === 'fulfilled') {
          prDataMap.set(result.value.prNum, result.value.prData);
        } else {
          logger.warn(`Failed to fetch PR data: ${result.reason?.message}`);
        }
      }
    }

    // 4. Create per-PR worktrees serially (git worktree add locks .git/worktrees)
    const worktreePathMap = new Map();
    for (const prNum of prNumbers) {
      if (state.cancelled) break;

      const prData = prDataMap.get(prNum);
      if (!prData) {
        state.prStatuses.set(prNum, { status: 'failed', error: 'Failed to fetch PR data from GitHub' });
        broadcastStackProgress(stackAnalysisId, state);
        continue;
      }

      try {
        state.prStatuses.set(prNum, { status: 'setting_up' });
        broadcastStackProgress(stackAnalysisId, state);

        const prInfo = { owner, repo, number: prNum };
        const { path: perPRWorktreePath } = await worktreeManager.createWorktreeForPR(
          prInfo, prData, repositoryPath
        );
        worktreePathMap.set(prNum, perPRWorktreePath);
      } catch (wtError) {
        logger.error(`Stack analysis: failed to create worktree for PR #${prNum}: ${wtError.message}`);
        state.prStatuses.set(prNum, { status: 'failed', error: `Worktree creation failed: ${wtError.message}` });
        broadcastStackProgress(stackAnalysisId, state);
      }
    }

    // 5. Launch analyses in parallel for all PRs with worktrees
    const readyPRs = prNumbers.filter(prNum => worktreePathMap.has(prNum) && !state.cancelled);

    await Promise.allSettled(
      readyPRs.map(prNum => {
        state.prStatuses.set(prNum, { status: 'running' });
        broadcastStackProgress(stackAnalysisId, state);

        // Surface analysisId as soon as the launcher creates it (before awaiting completion)
        const onAnalysisIdReady = (analysisId) => {
          const current = state.prStatuses.get(prNum);
          if (current) {
            current.analysisId = analysisId;
            broadcastStackProgress(stackAnalysisId, state);
          }
        };

        return analyzeStackPR(deps, db, config, {
          owner, repo, repository, prNum,
          worktreePath: worktreePathMap.get(prNum),
          analysisConfig, stackAnalysisId, state,
          githubToken, prData: prDataMap.get(prNum),
          onAnalysisIdReady
        }).then(result => {
          state.prStatuses.set(prNum, {
            status: result.status || 'failed',
            analysisId: result.analysisId,
            suggestionsCount: result.suggestionsCount || 0,
            error: result.error || null
          });
          broadcastStackProgress(stackAnalysisId, state);
        }).catch(error => {
          logger.error(`Stack analysis: PR #${prNum} failed: ${error.message}`);
          state.prStatuses.set(prNum, { status: 'failed', error: error.message });
          broadcastStackProgress(stackAnalysisId, state);
        });
      })
    );

    // 6. Set final status
    const anySucceeded = [...state.prStatuses.values()].some(s => s.status === 'completed');
    state.status = state.cancelled ? 'cancelled' : (anySucceeded ? 'completed' : 'failed');
    state.completedAt = new Date().toISOString();

  } catch (outerError) {
    logger.error(`Stack analysis ${stackAnalysisId} failed: ${outerError.message}`);
    state.status = 'failed';
    state.error = outerError.message;
  } finally {
    activeStackAnalyses.set(stackAnalysisId, state);
    broadcastStackProgress(stackAnalysisId, state);
  }
}

/**
 * Run setup + analysis for a single PR in the stack.
 * Called in parallel for all PRs.
 */
async function analyzeStackPR(deps, db, config, {
  owner, repo, repository, prNum, worktreePath,
  analysisConfig, stackAnalysisId, state, githubToken, prData,
  onAnalysisIdReady
}) {
  // 1. Setup PR (generates diff, stores metadata)
  const worktreeManager = new deps.GitWorktreeManager(db);
  await deps.setupStackPR({
    db, owner, repo, prNumber: prNum,
    githubToken, worktreePath, worktreeManager, prData
  });

  // 2. Fetch prMetadata from DB
  const prMetadataRepo = new PRMetadataRepository(db);
  const prMetadata = await prMetadataRepo.getByPR(prNum, repository);
  if (!prMetadata) {
    throw new Error(`PR metadata not found for PR #${prNum} after setup`);
  }

  const reviewRepo = new ReviewRepository(db);
  const { review } = await reviewRepo.getOrCreate({ prNumber: prNum, repository });
  const reviewId = review.id;

  // 3. Resolve analysis config
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

  // 4. Dispatch to launcher
  let analysisResult;

  if (configType === 'council' || configType === 'advanced' || isCouncil) {
    const { providerOverrides: councilProviderOverrides, providerOverridesMap: councilProviderOverridesMap } =
      buildCouncilProviderOverrides(config, repository, repoSettings);

    analysisResult = await launchStackCouncilAnalysis(deps, db, config, {
      reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
      globalInstructions, repoInstructions, requestInstructions,
      councilId, rawCouncilConfig, configType, onAnalysisIdReady,
      providerOverrides: councilProviderOverrides,
      providerOverridesMap: councilProviderOverridesMap
    });
  } else {
    let selectedProvider = reqProvider || repoSettings?.default_provider || config.default_provider || config.provider || 'claude';
    let selectedModel = reqModel || repoSettings?.default_model || config.default_model || config.model || 'opus';

    // Resolve load_skills across all config tiers
    const providerLoadSkills = config.providers?.[selectedProvider]?.load_skills;
    const loadSkills = resolveLoadSkills(config, repository, repoSettings, providerLoadSkills);
    const providerOverrides = { load_skills: loadSkills };

    const ProviderClass = deps.getProviderClass(selectedProvider);

    if (ProviderClass?.isExecutable) {
      analysisResult = await launchStackExecutableAnalysis(deps, db, config, {
        reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
        selectedProvider, selectedModel,
        repoInstructions, requestInstructions, onAnalysisIdReady,
        providerOverrides
      });
    } else {
      analysisResult = await launchStackSingleAnalysis(deps, db, config, {
        reviewId, worktreePath, prMetadata, prNum, owner, repo, repository,
        selectedProvider, selectedModel,
        globalInstructions, repoInstructions, requestInstructions,
        reqTier, reqEnabledLevels, onAnalysisIdReady,
        providerOverrides
      });
    }
  }

  return analysisResult;
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
  reqTier, reqEnabledLevels, onAnalysisIdReady,
  providerOverrides = {}
}) {
  const runId = uuidv4();
  const analysisId = runId;
  if (onAnalysisIdReady) onAnalysisIdReady(analysisId);
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

  const analyzer = new deps.Analyzer(db, selectedModel, selectedProvider, providerOverrides);
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
  councilId, rawCouncilConfig, configType, onAnalysisIdReady,
  providerOverrides = {},
  providerOverridesMap = null
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
      providerOverrides,
      providerOverridesMap,
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

  if (onAnalysisIdReady) onAnalysisIdReady(analysisId);

  // Wait for completion — use a timeout derived from the council config
  const timeoutMs = estimateCouncilTimeout(councilConfig, resolvedConfigType);
  logger.info(`Stack analysis: council timeout for PR #${prNum} estimated at ${Math.round(timeoutMs / 60000)}min`);
  const finalStatus = await deps.waitForAnalysisCompletion(analysisId, timeoutMs);

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
  repoInstructions, requestInstructions, onAnalysisIdReady,
  providerOverrides = {}
}) {
  const runId = uuidv4();
  const analysisId = runId;
  if (onAnalysisIdReady) onAnalysisIdReady(analysisId);

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
    extraInitialStatus: { prNumber: prNum },
    providerOverrides
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

    const stackAnalysisId = uuidv4();

    // Initialize tracking state
    const prStatuses = new Map();
    for (const n of prNumbers) {
      prStatuses.set(n, { status: 'pending' });
    }

    const state = {
      id: stackAnalysisId,
      status: 'running',
      triggerWorktreePath: worktreePath,
      prStatuses,
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
    currentPRNumber: null,
    currentPRIndex: null,
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

  // Set cancelled flag — the orchestrator checks this
  state.cancelled = true;

  // Cancel all currently running analyses
  for (const [prNum, prStatus] of state.prStatuses) {
    if (prStatus.status === 'running' && prStatus.analysisId) {
      killProcesses(prStatus.analysisId);
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
module.exports.estimateCouncilTimeout = estimateCouncilTimeout;
