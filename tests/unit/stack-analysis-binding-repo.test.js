// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for the config-derived setup wiring in `executeStackAnalysis`:
 *
 *  1. Binding resolution — `executeStackAnalysis` resolves the `repos[...]`
 *     config-binding key (via `resolveBindingRepositoryFromPR`) before calling
 *     `resolveHostBinding`, so monorepo `url_pattern` configs route alt-host
 *     stack analyses through the correct token / api_host instead of the bare
 *     `${owner}/${repo}` key (which would miss a monorepo-style binding).
 *
 *  2. Worktree config — `executeStackAnalysis` resolves the repo's worktree
 *     options (via `resolveRepoOptions`, keyed off the binding repository) and
 *     constructs the worktree-creating `GitWorktreeManager` with them. This
 *     guards a regression where stack worktrees ignored the repo's configured
 *     `worktree_name_template` / `worktree_directory` and fell back to
 *     pair-review's default naming ('{id}') and location (~/.pair-review/worktrees).
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
  vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'getPRHost').mockResolvedValue(undefined);
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
  // Shared owning-repo handle returned by resolveOwningRepo on every instance.
  // Its `.raw` resolves the repo toplevel used to derive repositoryPath.
  const mockOwningRepoGit = {
    raw: vi.fn().mockResolvedValue('/tmp/repos/test-repo\n'),
  };

  return {
    execSync: vi.fn().mockReturnValue('abc123def\n'),
    // Each construction yields a FRESH instance with its OWN spies. The
    // production flow constructs TWO managers (the creation manager in
    // executeStackAnalysis and a per-PR manager in analyzeStackPR); fresh
    // instances let tests tie config + create-call assertions to the specific
    // instance that actually created the worktree.
    GitWorktreeManager: vi.fn().mockImplementation(function () {
      this.resolveOwningRepo = vi.fn().mockResolvedValue(mockOwningRepoGit);
      this.createWorktreeForPR = vi.fn().mockImplementation(async (prInfo) => ({
        path: `/tmp/worktrees/pr-${prInfo.number}`, id: `wt-${prInfo.number}`,
      }));
      this.generateUnifiedDiff = vi.fn().mockResolvedValue('diff');
      this.getChangedFiles = vi.fn().mockResolvedValue([]);
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
    ...overrides,
  };
}

/**
 * Locate the GitWorktreeManager construction whose instance actually called
 * createWorktreeForPR, and return both its constructor options (2nd ctor arg)
 * and the args of its create call. Maps instance→construction index via
 * vitest's mock.results[i].value.
 */
function findCreationConstruction(GitWorktreeManagerMock) {
  const idx = GitWorktreeManagerMock.mock.results.findIndex(
    (r) => r && r.value && r.value.createWorktreeForPR && r.value.createWorktreeForPR.mock.calls.length > 0
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  return {
    ctorOptions: GitWorktreeManagerMock.mock.calls[idx][1],
    createArgs: GitWorktreeManagerMock.mock.results[idx].value.createWorktreeForPR.mock.calls[0],
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
  vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'getPRHost').mockResolvedValue(undefined);
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
    // Third arg is the main PR's host option; no stored host → {} (ambiguity).
    expect(resolveHostBinding).toHaveBeenCalledWith('acme-monorepo', config, {});
    expect(resolveHostBinding).not.toHaveBeenCalledWith('acme/widget-a', config, {});

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
    // resolveHostBinding is the lowercased PR identity (third arg = {} ambiguity).
    expect(resolveHostBinding).toHaveBeenCalledWith('acme/widget-a', config, {});
  });

  it('stack binding follows the MAIN PR stored host (dual repo alt-hosted stack)', async () => {
    // Dual repo whose trigger PR lives on the alt host. The stack binding must
    // resolve with { host: <alt> } so siblings are fetched from and stamped
    // with the alt host, not the two-arg github ambiguity binding.
    const config = {
      github_token: 'gh-tok',
      repos: {
        'acme/widget-a': { api_host: 'https://alt.example/api/v3', exclusive: false, token: 'alt-tok' }
      }
    };
    // Trigger PR (#10) is stored on the alt host.
    vi.spyOn(databaseModule.PRMetadataRepository.prototype, 'getPRHost')
      .mockResolvedValue('https://alt.example/api/v3');

    const resolveHostBinding = vi.fn().mockReturnValue({
      apiHost: 'https://alt.example/api/v3', host: 'https://alt.example/api/v3',
      token: 'alt-tok', features: {}, source: 'config:repos[acme/widget-a].token',
    });
    const deps = createMockDeps({ resolveHostBinding });
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // Binding resolved with the main PR's stored alt host.
    expect(resolveHostBinding).toHaveBeenCalledWith('acme/widget-a', config, { host: 'https://alt.example/api/v3' });
    // setupStackPR receives that binding, so stack-setup stamps binding.host (alt).
    const setupArgs = deps.setupStackPR.mock.calls[0][0];
    expect(setupArgs.binding.host).toBe('https://alt.example/api/v3');
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

  it('threads the repo checkout script into setupStackPR so it can skip built-in sparse expansion', async () => {
    // setupStackPR owns the per-PR sparse-cone expansion. It must receive the
    // repo's checkout script so it can honor the "script owns the cone" contract
    // and skip auto-expansion when a script is configured.
    const config = {
      repos: {
        'acme/widget-a': {
          checkout_script: '/scripts/checkout.sh',
          checkout_timeout_seconds: 120,
        },
      },
    };

    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(deps.setupStackPR).toHaveBeenCalled();
    const setupArgs = deps.setupStackPR.mock.calls[0][0];
    expect(setupArgs.checkoutScript).toBe('/scripts/checkout.sh');
  });

  it('threads a null checkout script into setupStackPR when none is configured (expansion path enabled)', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config: {} });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    expect(deps.setupStackPR).toHaveBeenCalled();
    const setupArgs = deps.setupStackPR.mock.calls[0][0];
    // No script configured → null/undefined, so setupStackPR runs its built-in
    // sparse-cone expansion for inherited worktrees.
    expect(setupArgs.checkoutScript == null).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Worktree config wiring (regression: stack worktrees ignored the repo's
  // configured worktree_name_template / worktree_directory).
  // -------------------------------------------------------------------------

  it('constructs the worktree manager with the repo\'s configured template + directory', async () => {
    // Repo configures a custom worktree directory and name template. Stack
    // analysis MUST honor them rather than falling back to the defaults.
    const config = {
      repos: {
        'acme/widget-a': {
          worktree_directory: '/custom/worktrees',
          worktree_name_template: '{owner}-{repo}-{pr_number}',
        },
      },
    };

    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // Tie the assertion to the instance that ACTUALLY created the worktree, not
    // just "some construction". The creating manager must have been built with
    // the resolved worktreeConfig, not the defaults.
    const { ctorOptions } = findCreationConstruction(deps.GitWorktreeManager);
    expect(ctorOptions).toEqual({
      worktreeBaseDir: '/custom/worktrees',
      nameTemplate: '{owner}-{repo}-{pr_number}',
    });
  });

  it('resolves worktree options off the binding key for monorepo url_pattern configs', async () => {
    // For a monorepo config, the worktree options live under the binding key
    // ("acme-monorepo"), NOT the PR identity ("acme/widget-a"). The fix keys
    // resolveRepoOptions off bindingRepository, so these must be applied.
    const config = {
      repos: {
        'acme-monorepo': {
          // api_host is required for resolveBindingRepositoryFromPR's
          // url_pattern probe to fire (it builds a synthetic URL from it).
          api_host: 'https://althost.example/api/v3',
          token: 'monorepo-token',
          url_pattern: '^https?://[^/]+/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/\\d+',
          worktree_directory: '/mono/worktrees',
          worktree_name_template: 'stack-{pr_number}',
        },
      },
    };

    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const { ctorOptions } = findCreationConstruction(deps.GitWorktreeManager);
    expect(ctorOptions).toEqual({
      worktreeBaseDir: '/mono/worktrees',
      nameTemplate: 'stack-{pr_number}',
    });
  });

  it('falls back to an empty worktree config when the repo configures none', async () => {
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config: {} });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    // With no configured worktree options the creating manager receives `{}`,
    // leaving the GitWorktreeManager constructor to apply its own defaults.
    const { ctorOptions } = findCreationConstruction(deps.GitWorktreeManager);
    expect(ctorOptions).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Checkout-option forwarding (regression: stack worktree creation dropped the
  // repo's checkout script / timeout and sparse-checkout inheritance).
  // -------------------------------------------------------------------------

  it('forwards the repo checkout script + timeout (and omits worktreeSourcePath) when a script is configured', async () => {
    // When a checkout script is configured, the worktree engine ignores
    // worktreeSourcePath (the script sets up sparse-checkout itself), so the
    // creation call must pass checkoutScript/checkoutTimeout but NOT
    // worktreeSourcePath.
    const config = {
      repos: {
        'acme/widget-a': {
          checkout_script: '/scripts/checkout.sh',
          checkout_timeout_seconds: 120,
        },
      },
    };

    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const { createArgs } = findCreationConstruction(deps.GitWorktreeManager);
    // createWorktreeForPR(prInfo, prData, repositoryPath, options) — options is 4th.
    expect(createArgs[3]).toMatchObject({
      checkoutScript: '/scripts/checkout.sh',
      checkoutTimeout: 120000,
    });
    expect(createArgs[3]).not.toHaveProperty('worktreeSourcePath');
  });

  it('forwards default checkout options and the trigger worktree as the sparse-checkout source when no script is configured', async () => {
    // No checkout script → checkoutScript is null and checkoutTimeout defaults
    // to 300000 (5 min). worktreeSourcePath is the trigger worktree path so the
    // per-PR worktree inherits its sparse-checkout layout.
    const deps = createMockDeps();
    const params = createDefaultParams(deps, { config: {} });
    initActiveState(params.stackAnalysisId, params.prNumbers);

    await executeStackAnalysis(params);

    const { createArgs } = findCreationConstruction(deps.GitWorktreeManager);
    expect(createArgs[3]).toMatchObject({
      checkoutScript: null,
      checkoutTimeout: 300000,
      worktreeSourcePath: '/tmp/worktree/test-repo',
    });
  });
});
