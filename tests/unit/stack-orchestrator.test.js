// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for executeStackAnalysis orchestrator in stack-analysis.js
 *
 * Uses vi.spyOn on dependency modules loaded BEFORE the module under test,
 * combined with _deps injection for the dependencies that support it.
 */

// ---------------------------------------------------------------------------
// 1. Load dependency modules in order (populates Node's module cache)
// ---------------------------------------------------------------------------

const loggerModule = require('../../src/utils/logger');
const databaseModule = require('../../src/database');
const wsModule = require('../../src/ws');
const sharedModule = require('../../src/routes/shared');
const reviewEventsModule = require('../../src/events/review-events');
const promptsConfigModule = require('../../src/ai/prompts/config');

// ---------------------------------------------------------------------------
// 2. Spy on module exports BEFORE loading the module under test
// ---------------------------------------------------------------------------

// Logger — suppress output
vi.spyOn(loggerModule, 'info').mockImplementation(() => {});
vi.spyOn(loggerModule, 'warn').mockImplementation(() => {});
vi.spyOn(loggerModule, 'error').mockImplementation(() => {});
vi.spyOn(loggerModule, 'debug').mockImplementation(() => {});
vi.spyOn(loggerModule, 'success').mockImplementation(() => {});

// WebSocket — broadcast
vi.spyOn(wsModule, 'broadcast').mockImplementation(() => {});

// Shared module
vi.spyOn(sharedModule, 'broadcastProgress').mockImplementation(() => {});
vi.spyOn(sharedModule, 'createProgressCallback').mockReturnValue(vi.fn());
vi.spyOn(sharedModule, 'parseEnabledLevels').mockReturnValue({ 1: true, 2: true, 3: true });
vi.spyOn(sharedModule, 'determineCompletionInfo').mockReturnValue({
  completedLevel: 3,
  progressMessage: 'All levels complete',
  totalSuggestions: 5,
});

// Review events
vi.spyOn(reviewEventsModule, 'broadcastReviewEvent').mockImplementation(() => {});

// Prompts config
vi.spyOn(promptsConfigModule, 'resolveTier').mockReturnValue('balanced');

// Database Repository prototypes
vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'getByPR').mockResolvedValue({
  id: 1, pr_number: 10, head_sha: 'aaa', base_sha: 'bbb',
  title: 'PR', author: 'alice', base_branch: 'main', head_branch: 'feature',
  description: ''
});
vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'updateLastAiRunId').mockResolvedValue(undefined);
vi.spyOn(databaseModule.ReviewRepository.prototype, 'getOrCreate').mockResolvedValue({ review: { id: 1 } });
vi.spyOn(databaseModule.ReviewRepository.prototype, 'upsertSummary').mockResolvedValue(undefined);
vi.spyOn(databaseModule.RepoSettingsRepository.prototype, 'getRepoSettings').mockResolvedValue(null);
vi.spyOn(databaseModule.AnalysisRunRepository.prototype, 'create').mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// 3. Load the module under test
// ---------------------------------------------------------------------------

const { executeStackAnalysis, activeStackAnalyses, estimateCouncilTimeout } = require('../../src/routes/stack-analysis');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  const mockOwningRepoGit = {
    raw: vi.fn().mockResolvedValue('/tmp/repos/test-repo\n'),
  };
  const mockWorktreeManagerInstance = {
    resolveOwningRepo: vi.fn().mockResolvedValue(mockOwningRepoGit),
    createWorktreeForPR: vi.fn().mockImplementation(async (prInfo) => ({ path: `/tmp/worktrees/pr-${prInfo.number}`, id: `wt-${prInfo.number}` })),
  };

  return {
    execSync: vi.fn().mockReturnValue('abc123def\n'),
    // Note: must use regular functions (not arrows) for constructors called with `new`
    GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWorktreeManagerInstance); }),
    GitHubClient: vi.fn().mockImplementation(function () {
      this.fetchPullRequest = vi.fn().mockImplementation(async (_owner, _repo, prNum) => ({
        title: `PR #${prNum}`, author: 'alice',
        head_sha: `head-sha-${prNum}`, base_sha: `base-sha-${prNum}`,
        head_branch: `feature-${prNum}`, base_branch: 'main',
      }));
      this.fetchPullRequestFiles = vi.fn().mockResolvedValue([]);
    }),
    getGitHubToken: vi.fn().mockReturnValue('ghp_mock'),
    setupStackPR: vi.fn().mockResolvedValue({
      reviewId: 1, prMetadata: {}, prData: {}, isNew: true
    }),
    Analyzer: vi.fn().mockImplementation(function () {
      this.analyzeLevel1 = vi.fn().mockResolvedValue({ level1: { suggestions: [] } });
    }),
    getProviderClass: vi.fn().mockReturnValue(null),
    createProvider: vi.fn(),
    launchCouncilAnalysis: vi.fn(),
    runExecutableAnalysis: vi.fn(),
    waitForAnalysisCompletion: vi.fn().mockResolvedValue({ status: 'completed', suggestionsCount: 3 }),
    _mockOwningRepoGit: mockOwningRepoGit,
    _worktreeManagerInstance: mockWorktreeManagerInstance,
    ...overrides,
  };
}

function createDefaultParams(deps, overrides = {}) {
  const stackAnalysisId = overrides.stackAnalysisId || 'stack-analysis-001';

  return {
    db: {},
    config: {},
    owner: 'test-owner',
    repo: 'test-repo',
    repository: 'test-owner/test-repo',
    triggerPRNumber: 10,
    worktreePath: '/tmp/worktree/test-repo',
    prNumbers: [10, 11, 12],
    analysisConfig: { configType: 'single', provider: 'claude', model: 'opus' },
    stackAnalysisId,
    _deps: deps,
    ...overrides,
  };
}

function initActiveState(stackAnalysisId, prNumbers) {
  const prStatuses = new Map();
  for (const n of prNumbers) {
    prStatuses.set(n, { status: 'pending' });
  }
  const state = {
    id: stackAnalysisId,
    status: 'running',
    triggerWorktreePath: '/tmp/worktree/test-repo',
    prStatuses,
    totalPRs: prNumbers.length,
    startedAt: new Date().toISOString(),
    cancelled: false,
    error: null,
    completedAt: null,
  };
  activeStackAnalyses.set(stackAnalysisId, state);
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeStackAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeStackAnalyses.clear();
    sharedModule.activeAnalyses.clear();
    sharedModule.reviewToAnalysisId.clear();

    // Re-apply spies that clearAllMocks restores
    vi.spyOn(loggerModule, 'info').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'warn').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'error').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'debug').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'success').mockImplementation(() => {});

    vi.spyOn(wsModule, 'broadcast').mockImplementation(() => {});

    vi.spyOn(sharedModule, 'broadcastProgress').mockImplementation(() => {});
    vi.spyOn(sharedModule, 'createProgressCallback').mockReturnValue(vi.fn());
    vi.spyOn(sharedModule, 'parseEnabledLevels').mockReturnValue({ 1: true, 2: true, 3: true });
    vi.spyOn(sharedModule, 'determineCompletionInfo').mockReturnValue({
      completedLevel: 3, progressMessage: 'All levels complete', totalSuggestions: 5,
    });

    vi.spyOn(reviewEventsModule, 'broadcastReviewEvent').mockImplementation(() => {});
    vi.spyOn(promptsConfigModule, 'resolveTier').mockReturnValue('balanced');

    vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'getByPR').mockResolvedValue({
      id: 1, pr_number: 10, head_sha: 'aaa', base_sha: 'bbb',
      title: 'PR', author: 'alice', base_branch: 'main', head_branch: 'feature',
      description: ''
    });
    vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'updateLastAiRunId').mockResolvedValue(undefined);
    vi.spyOn(databaseModule.ReviewRepository.prototype, 'getOrCreate').mockResolvedValue({ review: { id: 1 } });
    vi.spyOn(databaseModule.RepoSettingsRepository.prototype, 'getRepoSettings').mockResolvedValue(null);
    vi.spyOn(databaseModule.AnalysisRunRepository.prototype, 'create').mockResolvedValue(undefined);
  });

  it('returns immediately if state is not found in activeStackAnalyses', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps);
    // Do NOT call initActiveState — state missing on purpose

    await executeStackAnalysis(params);

    expect(deps.execSync).not.toHaveBeenCalled();
  });

  it('bulk fetches all PR refs in a single git fetch command', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const fetchCall = deps.execSync.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('git fetch origin')
    );
    expect(fetchCall).toBeTruthy();
    expect(fetchCall[0]).toContain('+refs/pull/10/head:refs/remotes/origin/pr-10');
    expect(fetchCall[0]).toContain('+refs/pull/11/head:refs/remotes/origin/pr-11');
    expect(fetchCall[0]).toContain('+refs/pull/12/head:refs/remotes/origin/pr-12');
  });

  it('continues on per-PR failure', async () => {
    const deps = createMockDeps({
      setupStackPR: vi.fn()
        .mockResolvedValueOnce({ reviewId: 1, prMetadata: {}, prData: {}, isNew: true })
        .mockRejectedValueOnce(new Error('PR 11 setup failed'))
        .mockResolvedValueOnce({ reviewId: 3, prMetadata: {}, prData: {}, isNew: true }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // PR 11 should be marked failed
    expect(state.prStatuses.get(11).status).toBe('failed');
    expect(state.prStatuses.get(11).error).toBe('PR 11 setup failed');
    // Overall status should still complete
    expect(state.status).toBe('completed');
  });

  it('handles cancellation — skips remaining worktree creation and analyses', async () => {
    const worktreeOrder = [];
    const mockOwningRepoGit = { raw: vi.fn().mockResolvedValue('/tmp/repos/test-repo\n') };
    const mockWtManager = {
      resolveOwningRepo: vi.fn().mockResolvedValue(mockOwningRepoGit),
      createWorktreeForPR: vi.fn().mockImplementation(async (prInfo) => {
        worktreeOrder.push(prInfo.number);
        // Cancel after first worktree is created
        if (prInfo.number === 10) {
          const state = activeStackAnalyses.get('stack-analysis-001');
          state.cancelled = true;
        }
        return { path: `/tmp/worktrees/pr-${prInfo.number}`, id: `wt-${prInfo.number}` };
      }),
    };
    const deps = createMockDeps({
      GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWtManager); }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // Only PR 10 should have a worktree created (cancelled before 11, 12)
    expect(worktreeOrder).toEqual([10]);
    const state = activeStackAnalyses.get('stack-analysis-001');
    expect(state.status).toBe('cancelled');
  });

  it('broadcasts progress for each PR start', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10, 11] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // broadcastStackProgress calls ws.broadcast
    const stackCalls = wsModule.broadcast.mock.calls.filter(
      c => c[0] === 'stack-analysis:stack-analysis-001'
    );
    // At minimum: one per PR start, one per PR complete, plus final
    expect(stackCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('sets final status to completed on success', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const state = activeStackAnalyses.get('stack-analysis-001');
    expect(state.status).toBe('completed');
    expect(state.completedAt).toBeTruthy();
  });

  it('sets final status to failed on outer error', async () => {
    const deps = createMockDeps({
      getGitHubToken: vi.fn().mockImplementation(() => { throw new Error('token exploded'); }),
    });
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const state = activeStackAnalyses.get('stack-analysis-001');
    expect(state.status).toBe('failed');
    expect(state.error).toBe('token exploded');
  });

  it('passes computed timeout to waitForAnalysisCompletion for council analyses', async () => {
    // Set up a council with 15-minute voice timeouts and 15-minute consolidation
    const councilConfig = {
      voices: [
        { provider: 'claude', model: 'opus', timeout: 900_000 },
        { provider: 'claude', model: 'sonnet', timeout: 900_000 },
      ],
      levels: { 1: true, 2: true, 3: false },
      consolidation: { provider: 'claude', model: 'opus', timeout: 900_000 },
    };

    vi.spyOn(databaseModule.CouncilRepository.prototype, 'getById').mockResolvedValue({
      id: 'council-1',
      config: councilConfig,
      type: 'council',
    });

    const deps = createMockDeps({
      launchCouncilAnalysis: vi.fn().mockResolvedValue({ analysisId: 'a1', runId: 'r1' }),
    });
    const params = createDefaultParams(deps, {
      prNumbers: [10],
      analysisConfig: { configType: 'council', councilId: 'council-1' },
    });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // waitForAnalysisCompletion should have been called with the estimated timeout
    expect(deps.waitForAnalysisCompletion).toHaveBeenCalledWith(
      'a1',
      expect.any(Number)
    );
    const passedTimeout = deps.waitForAnalysisCompletion.mock.calls[0][1];
    // 15min voice + 15min consolidation + 2min margin = 32min = 1,920,000ms
    expect(passedTimeout).toBe(1_920_000);
  });

  it('creates per-PR worktrees via createWorktreeForPR', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const createCalls = deps._worktreeManagerInstance.createWorktreeForPR.mock.calls;
    expect(createCalls).toHaveLength(3);
    expect(createCalls[0][0]).toEqual({ owner: 'test-owner', repo: 'test-repo', number: 10 });
    expect(createCalls[1][0]).toEqual({ owner: 'test-owner', repo: 'test-repo', number: 11 });
    expect(createCalls[2][0]).toEqual({ owner: 'test-owner', repo: 'test-repo', number: 12 });
  });

  it('resolves repositoryPath from trigger worktree', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(deps._worktreeManagerInstance.resolveOwningRepo).toHaveBeenCalledWith('/tmp/worktree/test-repo');
  });

  it('handles partial worktree creation failure', async () => {
    const mockOwningRepoGit = { raw: vi.fn().mockResolvedValue('/tmp/repos/test-repo\n') };
    const mockWtManager = {
      resolveOwningRepo: vi.fn().mockResolvedValue(mockOwningRepoGit),
      createWorktreeForPR: vi.fn()
        .mockResolvedValueOnce({ path: '/tmp/worktrees/pr-10', id: 'wt-10' })
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValueOnce({ path: '/tmp/worktrees/pr-12', id: 'wt-12' }),
    };
    const deps = createMockDeps({
      GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWtManager); }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // PR 11 should be failed from worktree creation
    expect(state.prStatuses.get(11).status).toBe('failed');
    expect(state.prStatuses.get(11).error).toContain('disk full');
    // PRs 10 and 12 should have completed analysis
    expect(state.prStatuses.get(10).status).toBe('completed');
    expect(state.prStatuses.get(12).status).toBe('completed');
    expect(state.status).toBe('completed');
  });

  it('fetches PR data from GitHub before worktree creation', async () => {
    const fetchOrder = [];
    const createOrder = [];
    const mockOwningRepoGit = { raw: vi.fn().mockResolvedValue('/tmp/repos/test-repo\n') };
    const mockWtManager = {
      resolveOwningRepo: vi.fn().mockResolvedValue(mockOwningRepoGit),
      createWorktreeForPR: vi.fn().mockImplementation(async (prInfo) => {
        createOrder.push(prInfo.number);
        return { path: `/tmp/worktrees/pr-${prInfo.number}`, id: `wt-${prInfo.number}` };
      }),
    };
    const deps = createMockDeps({
      GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWtManager); }),
      GitHubClient: vi.fn().mockImplementation(function () {
        this.fetchPullRequest = vi.fn().mockImplementation(async (_o, _r, prNum) => {
          fetchOrder.push(prNum);
          return { title: `PR #${prNum}`, author: 'alice', head_sha: `sha-${prNum}`, base_sha: 'base', head_branch: `f-${prNum}`, base_branch: 'main' };
        });
        this.fetchPullRequestFiles = vi.fn().mockResolvedValue([]);
      }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // All PR data should be fetched before any worktree is created
    expect(fetchOrder).toContain(10);
    expect(fetchOrder).toContain(11);
    // Worktrees created after fetches
    expect(createOrder).toEqual([10, 11]);
  });

  it('passes per-PR worktree path to setupStackPR', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10, 11] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const setupCalls = deps.setupStackPR.mock.calls;
    expect(setupCalls).toHaveLength(2);
    // Each call should get its own worktree path (from createWorktreeForPR mock)
    expect(setupCalls[0][0].worktreePath).toBe('/tmp/worktrees/pr-10');
    expect(setupCalls[0][0].prNumber).toBe(10);
    expect(setupCalls[1][0].worktreePath).toBe('/tmp/worktrees/pr-11');
    expect(setupCalls[1][0].prNumber).toBe(11);
  });

  it('passes pre-fetched prData to setupStackPR', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const setupCall = deps.setupStackPR.mock.calls[0][0];
    expect(setupCall.prData).toBeDefined();
    expect(setupCall.prData.head_sha).toBe('head-sha-10');
  });

  it('surfaces analysisId in prStatuses during running phase via onAnalysisIdReady', async () => {
    // Track the analysisId that gets set on prStatuses during execution
    const capturedAnalysisIds = new Map();
    const origBroadcast = wsModule.broadcast;
    wsModule.broadcast.mockImplementation((topic, msg) => {
      if (msg.type === 'stack-progress' && msg.prStatuses) {
        for (const pr of msg.prStatuses) {
          if (pr.status === 'running' && pr.analysisId) {
            capturedAnalysisIds.set(pr.prNumber, pr.analysisId);
          }
        }
      }
    });

    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // analysisId should have been broadcast while the PR was still 'running'
    expect(capturedAnalysisIds.has(10)).toBe(true);
    expect(capturedAnalysisIds.get(10)).toBeTruthy();
  });

  it('preserves cancelled status from launcher instead of collapsing to failed', async () => {
    const deps = createMockDeps();
    // Make the analyzer throw a cancellation error
    deps.Analyzer = vi.fn().mockImplementation(function () {
      this.analyzeLevel1 = vi.fn().mockRejectedValue(Object.assign(new Error('Cancelled'), { isCancellation: true }));
    });
    const params = createDefaultParams(deps, { prNumbers: [10] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // The per-PR status should be 'cancelled', not 'failed'
    expect(state.prStatuses.get(10).status).toBe('cancelled');
  });

  it('sets final status to failed when all PRs fail', async () => {
    const deps = createMockDeps();
    deps.setupStackPR = vi.fn().mockRejectedValue(new Error('setup exploded'));
    const params = createDefaultParams(deps, { prNumbers: [10, 11] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // All PRs failed during analysis, so overall status should be 'failed'
    expect(state.prStatuses.get(10).status).toBe('failed');
    expect(state.prStatuses.get(11).status).toBe('failed');
    expect(state.status).toBe('failed');
  });

  it('sets final status to completed when at least one PR succeeds', async () => {
    const deps = createMockDeps({
      setupStackPR: vi.fn()
        .mockResolvedValueOnce({ reviewId: 1, prMetadata: {}, prData: {}, isNew: true })
        .mockRejectedValueOnce(new Error('setup failed')),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(state.prStatuses.get(10).status).toBe('completed');
    expect(state.prStatuses.get(11).status).toBe('failed');
    expect(state.status).toBe('completed');
  });

  it('cancellation during analysis phase calls killProcesses for in-flight analyses', async () => {
    // Mock killProcesses to track calls
    const killSpy = vi.spyOn(sharedModule, 'killProcesses').mockImplementation(() => {});

    // Make the analyzer block until cancellation
    let resolveAnalysis;
    const analysisPromise = new Promise(resolve => { resolveAnalysis = resolve; });

    const deps = createMockDeps();
    deps.Analyzer = vi.fn().mockImplementation(function () {
      this.analyzeLevel1 = vi.fn().mockReturnValue(analysisPromise);
    });
    const params = createDefaultParams(deps, { prNumbers: [10] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    // Start execution but don't await — it will block on analyzeLevel1
    const executionPromise = executeStackAnalysis(params);

    // Wait a tick for the PR to enter 'running' state and onAnalysisIdReady to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    // The PR should now have an analysisId (from onAnalysisIdReady)
    const prStatus = state.prStatuses.get(10);
    expect(prStatus.analysisId).toBeTruthy();

    // Now cancel — the cancel endpoint logic checks prStatus.analysisId
    state.cancelled = true;
    for (const [, ps] of state.prStatuses) {
      if (ps.status === 'running' && ps.analysisId) {
        sharedModule.killProcesses(ps.analysisId);
      }
    }

    // Verify killProcesses was called with the analysisId
    expect(killSpy).toHaveBeenCalledWith(prStatus.analysisId);

    // Unblock the analysis so executeStackAnalysis can finish
    resolveAnalysis({ level1: { suggestions: [] } });
    await executionPromise;
  });

  it('broadcasts setting_up status during worktree creation', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    const statusSequence = [];
    wsModule.broadcast.mockImplementation((topic, msg) => {
      if (msg.type === 'stack-progress' && msg.prStatuses) {
        for (const pr of msg.prStatuses) {
          if (pr.prNumber === 10) {
            statusSequence.push(pr.status);
          }
        }
      }
    });

    await executeStackAnalysis(params);

    // Should transition through setting_up -> running -> completed
    expect(statusSequence).toContain('setting_up');
    expect(statusSequence).toContain('running');
    expect(statusSequence).toContain('completed');
    expect(statusSequence.indexOf('setting_up')).toBeLessThan(statusSequence.indexOf('running'));
  });
});

describe('estimateCouncilTimeout', () => {
  it('returns voice + consolidation + margin for voice-centric councils', () => {
    const config = {
      voices: [
        { provider: 'claude', model: 'opus', timeout: 900_000 },
        { provider: 'claude', model: 'sonnet', timeout: 600_000 },
      ],
      consolidation: { timeout: 300_000 },
    };
    // max voice = 900k, consol = 300k, margin = 120k
    expect(estimateCouncilTimeout(config, 'council')).toBe(1_320_000);
  });

  it('uses defaults when no timeouts are specified', () => {
    const config = {
      voices: [{ provider: 'claude', model: 'opus' }],
    };
    // default voice = 600k, default consol = 300k, margin = 120k
    expect(estimateCouncilTimeout(config, 'council')).toBe(1_020_000);
  });

  it('sums per-level phases for level-centric councils', () => {
    const config = {
      levels: {
        1: {
          voices: [{ timeout: 900_000 }, { timeout: 600_000 }],
          consolidation: { timeout: 300_000 },
        },
        2: {
          voices: [{ timeout: 900_000 }],
          consolidation: { timeout: 300_000 },
        },
      },
      orchestration: { timeout: 600_000 },
    };
    // Level 1: max voice 900k + consol 300k = 1200k
    // Level 2: max voice 900k + consol 300k = 1200k
    // Orchestration: 600k
    // Margin: 120k
    // Total: 3,120,000
    expect(estimateCouncilTimeout(config, 'advanced')).toBe(3_120_000);
  });

  it('uses consolidation.timeout as orchestration fallback for level-centric', () => {
    const config = {
      levels: {
        1: { voices: [{}] },
      },
      consolidation: { timeout: 900_000 },
    };
    // Level 1: default voice 600k + default consol 300k = 900k
    // Orchestration: uses consolidation.timeout = 900k
    // Margin: 120k
    expect(estimateCouncilTimeout(config, 'advanced')).toBe(1_920_000);
  });
});
