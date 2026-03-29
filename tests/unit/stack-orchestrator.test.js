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
const worktreeLockModule = require('../../src/git/worktree-lock');
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

// Worktree lock singleton
vi.spyOn(worktreeLockModule.worktreeLock, 'acquire').mockReturnValue(true);
vi.spyOn(worktreeLockModule.worktreeLock, 'release').mockReturnValue(true);

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
vi.spyOn(databaseModule.WorktreeRepository.prototype, 'findByPR').mockResolvedValue(null);
vi.spyOn(databaseModule.WorktreeRepository.prototype, 'updatePath').mockResolvedValue(undefined);
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

const { executeStackAnalysis, activeStackAnalyses } = require('../../src/routes/stack-analysis');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  const mockWorktreeManagerInstance = {
    checkoutBranch: vi.fn().mockResolvedValue('abc123'),
  };

  return {
    execSync: vi.fn().mockReturnValue('abc123def\n'),
    // Note: must use regular functions (not arrows) for constructors called with `new`
    GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWorktreeManagerInstance); }),
    GitHubClient: vi.fn().mockImplementation(function () {
      this.fetchPullRequest = vi.fn().mockResolvedValue({});
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
    worktreePath: '/tmp/worktree/test-repo',
    originalBranch: null,
    prStatuses,
    currentPRNumber: null,
    currentPRIndex: null,
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

    vi.spyOn(worktreeLockModule.worktreeLock, 'acquire').mockReturnValue(true);
    vi.spyOn(worktreeLockModule.worktreeLock, 'release').mockReturnValue(true);

    vi.spyOn(wsModule, 'broadcast').mockImplementation(() => {});

    vi.spyOn(sharedModule, 'broadcastProgress').mockImplementation(() => {});
    vi.spyOn(sharedModule, 'createProgressCallback').mockReturnValue(vi.fn());
    vi.spyOn(sharedModule, 'parseEnabledLevels').mockReturnValue({ 1: true, 2: true, 3: true });
    vi.spyOn(sharedModule, 'determineCompletionInfo').mockReturnValue({
      completedLevel: 3, progressMessage: 'All levels complete', totalSuggestions: 5,
    });

    vi.spyOn(reviewEventsModule, 'broadcastReviewEvent').mockImplementation(() => {});
    vi.spyOn(promptsConfigModule, 'resolveTier').mockReturnValue('balanced');

    vi.spyOn(databaseModule.WorktreeRepository.prototype, 'findByPR').mockResolvedValue(null);
    vi.spyOn(databaseModule.WorktreeRepository.prototype, 'updatePath').mockResolvedValue(undefined);
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

    expect(worktreeLockModule.worktreeLock.acquire).not.toHaveBeenCalled();
    expect(deps.execSync).not.toHaveBeenCalled();
  });

  it('acquires lock at start', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(worktreeLockModule.worktreeLock.acquire).toHaveBeenCalledWith(
      '/tmp/worktree/test-repo',
      'stack-analysis-001'
    );
  });

  it('fails if lock cannot be acquired', async () => {
    vi.spyOn(worktreeLockModule.worktreeLock, 'acquire').mockReturnValue(false);

    const deps = createMockDeps();
    const params = createDefaultParams(deps);
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(state.status).toBe('failed');
    expect(state.error).toContain('already locked');
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

  it('processes PRs in sequential order', async () => {
    const checkoutOrder = [];
    const mockWtManager = {
      checkoutBranch: vi.fn().mockImplementation((_path, prNum) => {
        checkoutOrder.push(prNum);
        return Promise.resolve('sha');
      }),
    };
    const deps = createMockDeps({
      GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWtManager); }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(checkoutOrder).toEqual([10, 11, 12]);
  });

  it('continues on per-PR failure', async () => {
    const checkoutOrder = [];
    const mockWtManager = {
      checkoutBranch: vi.fn().mockImplementation((_path, prNum) => {
        checkoutOrder.push(prNum);
        return Promise.resolve('sha');
      }),
    };
    const deps = createMockDeps({
      GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWtManager); }),
      setupStackPR: vi.fn()
        .mockResolvedValueOnce({ reviewId: 1, prMetadata: {}, prData: {}, isNew: true })
        .mockRejectedValueOnce(new Error('PR 11 setup failed'))
        .mockResolvedValueOnce({ reviewId: 3, prMetadata: {}, prData: {}, isNew: true }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    const state = initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // All three PRs should have been attempted
    expect(checkoutOrder).toEqual([10, 11, 12]);
    // PR 11 should be marked failed
    expect(state.prStatuses.get(11).status).toBe('failed');
    expect(state.prStatuses.get(11).error).toBe('PR 11 setup failed');
    // Overall status should still complete
    expect(state.status).toBe('completed');
  });

  it('restores original branch in finally block (named branch)', async () => {
    const deps = createMockDeps({
      execSync: vi.fn()
        .mockReturnValueOnce('abc123\n')         // git rev-parse HEAD
        .mockReturnValueOnce('feature-branch\n')  // git rev-parse --abbrev-ref HEAD
        .mockReturnValue('')                       // subsequent calls
    });
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const checkoutCall = deps.execSync.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('git checkout feature-branch')
    );
    expect(checkoutCall).toBeTruthy();
  });

  it('restores via reset --hard when in detached HEAD', async () => {
    const deps = createMockDeps({
      execSync: vi.fn()
        .mockReturnValueOnce('abc123\n')  // git rev-parse HEAD
        .mockReturnValueOnce('HEAD\n')    // git rev-parse --abbrev-ref HEAD (detached)
        .mockReturnValue('')              // subsequent calls
    });
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const resetCall = deps.execSync.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('git reset --hard abc123')
    );
    expect(resetCall).toBeTruthy();
  });

  it('restores worktree records that were changed (Hazard #1)', async () => {
    const originalWt = { id: 99, path: '/original/worktree/10', pr_number: 10 };
    const findByPR = databaseModule.WorktreeRepository.prototype.findByPR;
    findByPR
      // Snapshot phase
      .mockResolvedValueOnce(originalWt)  // PR 10
      .mockResolvedValueOnce(null)        // PR 11
      .mockResolvedValueOnce(null)        // PR 12
      // Finally: restore phase — returns record with changed path
      .mockResolvedValueOnce({ id: 99, path: '/tmp/worktree/test-repo', pr_number: 10 });

    const deps = createMockDeps();
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(databaseModule.WorktreeRepository.prototype.updatePath)
      .toHaveBeenCalledWith(99, '/original/worktree/10');
  });

  it('releases lock on success', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(worktreeLockModule.worktreeLock.release).toHaveBeenCalledWith(
      '/tmp/worktree/test-repo',
      'stack-analysis-001'
    );
  });

  it('releases lock on error', async () => {
    const deps = createMockDeps({
      getGitHubToken: vi.fn().mockImplementation(() => { throw new Error('token crash'); }),
    });
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(worktreeLockModule.worktreeLock.release).toHaveBeenCalledWith(
      '/tmp/worktree/test-repo',
      'stack-analysis-001'
    );
  });

  it('handles cancellation — stops loop early', async () => {
    const checkoutOrder = [];
    const mockWtManager = {
      checkoutBranch: vi.fn().mockImplementation((_path, prNum) => {
        checkoutOrder.push(prNum);
        return Promise.resolve('sha');
      }),
    };

    const deps = createMockDeps({
      GitWorktreeManager: vi.fn().mockImplementation(function () { Object.assign(this, mockWtManager); }),
      setupStackPR: vi.fn().mockImplementation(async ({ prNumber }) => {
        // Cancel after first PR completes setup
        if (prNumber === 10) {
          const state = activeStackAnalyses.get('stack-analysis-001');
          state.cancelled = true;
        }
        return { reviewId: 1, prMetadata: {}, prData: {}, isNew: true };
      }),
    });
    const params = createDefaultParams(deps, { prNumbers: [10, 11, 12] });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // Cancellation is checked at the TOP of each loop iteration.
    // PR 10 starts, setup runs (sets cancelled=true), analysis completes.
    // Next iteration: cancelled=true, break.
    expect(checkoutOrder).toEqual([10]);

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
    vi.spyOn(worktreeLockModule.worktreeLock, 'acquire').mockImplementation(() => {
      throw new Error('lock exploded');
    });

    const deps = createMockDeps();
    const params = createDefaultParams(deps);
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const state = activeStackAnalyses.get('stack-analysis-001');
    expect(state.status).toBe('failed');
    expect(state.error).toBe('lock exploded');
    // Lock release should still be called in finally
    expect(worktreeLockModule.worktreeLock.release).toHaveBeenCalled();
  });
});
