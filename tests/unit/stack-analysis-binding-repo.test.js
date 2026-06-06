// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests verifying that `executeStackAnalysis` resolves the
 * `repos[...]` config-binding key (via `resolveBindingRepositoryFromPR`)
 * before calling `resolveHostBinding`. This is required so monorepo
 * `url_pattern` configs route alt-host stack analyses through the
 * correct token / api_host instead of the bare `${owner}/${repo}` key
 * (which would miss a monorepo-style binding entirely).
 *
 * Mirrors the test patterns established in `stack-orchestrator.test.js`:
 * vi.spyOn on dependency modules loaded before the module under test,
 * combined with `_deps` injection for the dependencies that support it.
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
  completedLevel: 3,
  progressMessage: 'All levels complete',
  totalSuggestions: 5,
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
vi.spyOn(databaseModule.ReviewRepository.prototype, 'upsertSummary').mockResolvedValue(undefined);
vi.spyOn(databaseModule.RepoSettingsRepository.prototype, 'getRepoSettings').mockResolvedValue(null);
vi.spyOn(databaseModule.AnalysisRunRepository.prototype, 'create').mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// 3. Use the REAL resolveBindingRepositoryFromPR — that's the function under
//    test for the positive monorepo case. The route-level wiring should
//    pass `(owner, repo, config)` to it and pass its result on to
//    `resolveHostBinding`.
// ---------------------------------------------------------------------------

const { resolveBindingRepositoryFromPR: realResolveBindingRepositoryFromPR } =
  require('../../src/config');

// ---------------------------------------------------------------------------
// 4. Load the module under test
// ---------------------------------------------------------------------------

const { executeStackAnalysis, activeStackAnalyses } =
  require('../../src/routes/stack-analysis');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  const mockOwningRepoGit = {
    raw: vi.fn().mockResolvedValue('/tmp/repos/test-repo\n'),
  };
  const mockWorktreeManagerInstance = {
    resolveOwningRepo: vi.fn().mockResolvedValue(mockOwningRepoGit),
    createWorktreeForPR: vi.fn().mockImplementation(async (prInfo) => ({
      path: `/tmp/worktrees/pr-${prInfo.number}`, id: `wt-${prInfo.number}`
    })),
  };

  return {
    execSync: vi.fn().mockReturnValue('abc123def\n'),
    GitWorktreeManager: vi.fn().mockImplementation(function () {
      Object.assign(this, mockWorktreeManagerInstance);
    }),
    GitHubClient: vi.fn().mockImplementation(function () {
      this.fetchPullRequest = vi.fn().mockImplementation(async (_owner, _repo, prNum) => ({
        title: `PR #${prNum}`, author: 'alice',
        head_sha: `head-sha-${prNum}`, base_sha: `base-sha-${prNum}`,
        head_branch: `feature-${prNum}`, base_branch: 'main',
      }));
      this.fetchPullRequestFiles = vi.fn().mockResolvedValue([]);
    }),
    getGitHubToken: vi.fn().mockReturnValue('ghp_mock'),
    resolveHostBinding: vi.fn().mockReturnValue({
      apiHost: null,
      token: 'ghp_mock',
      features: {
        pending_review_check: 'graphql',
        stack_walker: 'graphql',
        review_lifecycle: 'graphql',
        pending_review_comments: 'graphql'
      },
      source: 'config:github_token'
    }),
    // Real resolver by default; tests can override per-case.
    resolveBindingRepositoryFromPR: vi.fn().mockImplementation(realResolveBindingRepositoryFromPR),
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
  const stackAnalysisId = overrides.stackAnalysisId || 'stack-binding-001';
  return {
    db: {},
    config: {},
    owner: 'acme',
    repo: 'widget-a',
    repository: 'acme/widget-a',
    triggerPRNumber: 10,
    worktreePath: '/tmp/worktree/test-repo',
    prNumbers: [10],
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

describe('executeStackAnalysis — bindingRepository resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeStackAnalyses.clear();
    sharedModule.activeAnalyses.clear();
    sharedModule.reviewToAnalysisId.clear();

    // Re-apply spies (clearAllMocks restores originals)
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

  it('positive monorepo case: looks up the config-binding key, not the PR identity', async () => {
    // Monorepo-style config: one `repos[...]` entry serves the captured
    // `acme/widget-a` PR via url_pattern. The config-binding key is
    // "acme-monorepo" — completely unrelated to "acme/widget-a".
    const config = {
      repos: {
        'acme-monorepo': {
          api_host: 'https://althost.example/api/v3',
          token: 'monorepo-token',
          url_pattern: '^https?://[^/]+/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/\\d+',
        },
      },
    };

    // Track exactly what `resolveHostBinding` was called with.
    const resolveHostBinding = vi.fn().mockReturnValue({
      apiHost: 'https://althost.example/api/v3',
      token: 'monorepo-token',
      features: {
        pending_review_check: 'rest',
        stack_walker: 'rest',
        review_lifecycle: 'rest',
        pending_review_comments: 'host'
      },
      source: 'config:repos[acme-monorepo].token',
    });

    const deps = createMockDeps({ resolveHostBinding });
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // The binding lookup MUST use the resolved config key, not the PR identity.
    expect(deps.resolveBindingRepositoryFromPR).toHaveBeenCalledWith('acme', 'widget-a', config);
    expect(resolveHostBinding).toHaveBeenCalledWith('acme-monorepo', config);
    expect(resolveHostBinding).not.toHaveBeenCalledWith('acme/widget-a', config);

    // The monorepo token should reach the GitHubClient via the binding.
    const ghClientArgs = deps.GitHubClient.mock.calls.map(c => c[0]);
    const sawMonorepoBinding = ghClientArgs.some(arg =>
      arg && typeof arg === 'object' && arg.token === 'monorepo-token'
    );
    expect(sawMonorepoBinding).toBe(true);
  });

  it('no-pattern fallback: bindingRepository falls back to the PR identity', async () => {
    // No `repos[...]` entry matches → fallback to `${owner}/${repo}`.
    const config = {
      // Unrelated entries that should NOT capture acme/widget-a.
      repos: {
        'someone-else/other-repo': {
          api_host: 'https://other.example/api/v3',
          token: 'other-token',
        },
      },
    };

    const resolveHostBinding = vi.fn().mockReturnValue({
      apiHost: null, token: 'fallback-token', features: {}, source: 'config:github_token',
    });
    const deps = createMockDeps({ resolveHostBinding });
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(deps.resolveBindingRepositoryFromPR).toHaveBeenCalledWith('acme', 'widget-a', config);
    // The real resolver lowercases the fallback, so the key passed to
    // resolveHostBinding is the lowercased PR identity.
    expect(resolveHostBinding).toHaveBeenCalledWith('acme/widget-a', config);
  });

  it('setupStackPR plumbing: invoked with bindingRepository set to the resolved binding key', async () => {
    const config = {
      repos: {
        'acme-monorepo': {
          api_host: 'https://althost.example/api/v3',
          token: 'monorepo-token',
          url_pattern: '^https?://[^/]+/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/\\d+',
        },
      },
    };

    const deps = createMockDeps({
      resolveHostBinding: vi.fn().mockReturnValue({
        apiHost: 'https://althost.example/api/v3',
        token: 'monorepo-token',
        features: {},
        source: 'config:repos[acme-monorepo].token',
      }),
    });
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(deps.setupStackPR).toHaveBeenCalled();
    const setupArgs = deps.setupStackPR.mock.calls[0][0];
    expect(setupArgs.bindingRepository).toBe('acme-monorepo');
    // PR identity is preserved on the same call for DB rows / worktree identity.
    expect(setupArgs.owner).toBe('acme');
    expect(setupArgs.repo).toBe('widget-a');
    expect(setupArgs.prNumber).toBe(10);
  });

  it('setupStackPR plumbing in fallback mode: bindingRepository equals the PR identity', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config: {} });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(deps.setupStackPR).toHaveBeenCalled();
    const setupArgs = deps.setupStackPR.mock.calls[0][0];
    // Real resolver returns lowercased `${owner}/${repo}` fallback.
    expect(setupArgs.bindingRepository).toBe('acme/widget-a');
  });
});
