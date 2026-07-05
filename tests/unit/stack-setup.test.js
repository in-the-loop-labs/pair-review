// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for setupStackPR in stack-setup.js
 *
 * Note: vi.mock does not intercept CJS requires from transitive dependencies
 * in vitest's forks pool mode. We load dependency modules first and use
 * vi.spyOn on their exports so that when stack-setup.js destructures at
 * load time, it picks up the spied values.
 */

// 1. Load dependency modules first (populates Node's module cache)
const loggerModule = require('../../src/utils/logger');
const clientModule = require('../../src/github/client');
const prSetupModule = require('../../src/setup/pr-setup');

// 2. Spy on exports before loading the module under test
vi.spyOn(loggerModule, 'info').mockImplementation(() => {});
vi.spyOn(loggerModule, 'warn').mockImplementation(() => {});
vi.spyOn(loggerModule, 'error').mockImplementation(() => {});
vi.spyOn(loggerModule, 'debug').mockImplementation(() => {});

const mockStorePRData = vi.spyOn(prSetupModule, 'storePRData');

// 3. Load the module under test (destructures from the spied modules)
const { setupStackPR } = require('../../src/setup/stack-setup');

describe('setupStackPR', () => {
  let mockWorktreeManager;
  let mockDb;

  const fakePRData = {
    title: 'Add feature X',
    body: 'This PR adds feature X',
    author: 'alice',
    base_branch: 'main',
    head_branch: 'feature-x',
    base_sha: 'aaa111',
    head_sha: 'bbb222',
  };

  const fakePRFiles = [
    { filename: 'src/index.js', status: 'modified', additions: 5, deletions: 2 },
    { filename: 'src/utils.js', status: 'added', additions: 20, deletions: 0 },
  ];

  const defaultParams = () => ({
    db: mockDb,
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 42,
    githubToken: 'ghp_test_token',
    worktreePath: '/tmp/worktree/test-repo',
    worktreeManager: mockWorktreeManager,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {};

    // Re-spy logger (clearAllMocks restores originals)
    vi.spyOn(loggerModule, 'info').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'warn').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'error').mockImplementation(() => {});
    vi.spyOn(loggerModule, 'debug').mockImplementation(() => {});

    // Spy on GitHubClient prototype methods
    vi.spyOn(clientModule.GitHubClient.prototype, 'fetchPullRequest')
      .mockResolvedValue(fakePRData);
    vi.spyOn(clientModule.GitHubClient.prototype, 'fetchPullRequestFiles')
      .mockResolvedValue(fakePRFiles);

    mockStorePRData.mockResolvedValue({ isNewReview: true, reviewId: 101 });

    mockWorktreeManager = {
      generateUnifiedDiff: vi.fn().mockResolvedValue('diff --git a/src/index.js b/src/index.js\n+added line'),
      getChangedFiles: vi.fn().mockResolvedValue([
        { filename: 'src/index.js', additions: 5, deletions: 2 },
        { filename: 'src/utils.js', additions: 20, deletions: 0 },
      ]),
      // Default to non-sparse so the expansion path is a no-op for existing
      // tests; sparse-specific tests override these per-case.
      isSparseCheckoutEnabled: vi.fn().mockResolvedValue(false),
      ensurePRDirectoriesInSparseCheckout: vi.fn().mockResolvedValue([]),
    };
  });

  it('happy path: creates PR metadata and review via storePRData', async () => {
    const result = await setupStackPR(defaultParams());

    expect(result).toEqual({
      reviewId: 101,
      prMetadata: {
        owner: 'test-owner',
        repo: 'test-repo',
        number: 42,
        title: 'Add feature X',
        author: 'alice',
        base_branch: 'main',
        head_branch: 'feature-x',
      },
      prData: fakePRData,
      isNew: true,
    });
  });

  it('fetches PR data and files from GitHub', async () => {
    await setupStackPR(defaultParams());

    expect(clientModule.GitHubClient.prototype.fetchPullRequest)
      .toHaveBeenCalledWith('test-owner', 'test-repo', 42);
    expect(clientModule.GitHubClient.prototype.fetchPullRequestFiles)
      .toHaveBeenCalledWith('test-owner', 'test-repo', 42);
  });

  it('generates diff using worktreeManager with correct args', async () => {
    await setupStackPR(defaultParams());

    expect(mockWorktreeManager.generateUnifiedDiff).toHaveBeenCalledWith(
      '/tmp/worktree/test-repo',
      fakePRData
    );
  });

  it('gets changed files from worktreeManager', async () => {
    await setupStackPR(defaultParams());

    expect(mockWorktreeManager.getChangedFiles).toHaveBeenCalledWith(
      '/tmp/worktree/test-repo',
      fakePRData
    );
  });

  it('calls storePRData with correct arguments', async () => {
    const diff = 'diff --git a/src/index.js b/src/index.js\n+added line';
    const changedFiles = [
      { filename: 'src/index.js', additions: 5, deletions: 2 },
      { filename: 'src/utils.js', additions: 20, deletions: 0 },
    ];

    await setupStackPR(defaultParams());

    expect(mockStorePRData).toHaveBeenCalledWith(
      mockDb,
      { owner: 'test-owner', repo: 'test-repo', number: 42 },
      fakePRData,
      diff,
      changedFiles,
      '/tmp/worktree/test-repo',
      // No binding is passed in these params, so no host is stamped.
      { host: undefined }
    );
  });

  it('stamps the binding host on storePRData when a binding is supplied', async () => {
    await setupStackPR({
      ...defaultParams(),
      binding: { apiHost: 'https://alt.example/api/v3', host: 'https://alt.example/api/v3', token: 'alt-tok', features: {} }
    });

    const call = mockStorePRData.mock.calls[0];
    expect(call[6]).toEqual({ host: 'https://alt.example/api/v3' });
  });

  it('handles already-existing PR records (isNew is false)', async () => {
    mockStorePRData.mockResolvedValue({ isNewReview: false, reviewId: 55 });

    const result = await setupStackPR(defaultParams());

    expect(result.isNew).toBe(false);
    expect(result.reviewId).toBe(55);
  });

  it('propagates GitHub fetchPullRequest failure', async () => {
    vi.spyOn(clientModule.GitHubClient.prototype, 'fetchPullRequest')
      .mockRejectedValue(new Error('404 Not Found'));

    await expect(setupStackPR(defaultParams())).rejects.toThrow('404 Not Found');
  });

  it('propagates GitHub fetchPullRequestFiles failure', async () => {
    vi.spyOn(clientModule.GitHubClient.prototype, 'fetchPullRequestFiles')
      .mockRejectedValue(new Error('rate limit'));

    await expect(setupStackPR(defaultParams())).rejects.toThrow('rate limit');
  });

  it('propagates diff generation failure', async () => {
    mockWorktreeManager.generateUnifiedDiff.mockRejectedValue(new Error('git diff failed'));

    await expect(setupStackPR(defaultParams())).rejects.toThrow('git diff failed');
  });

  it('propagates storePRData failure', async () => {
    mockStorePRData.mockRejectedValue(new Error('DB write failed'));

    await expect(setupStackPR(defaultParams())).rejects.toThrow('DB write failed');
  });

  // -------------------------------------------------------------------------
  // Sparse-checkout expansion (regression: stack worktrees inherit the trigger
  // worktree's sparse cone but never expanded it for the PR's directories, so
  // downstream file-context / codebase-context analysis read an incomplete
  // on-disk checkout and silently under-reviewed sibling-PR files).
  // -------------------------------------------------------------------------

  it('expands sparse-checkout for PR directories when sparse and no checkout script', async () => {
    mockWorktreeManager.isSparseCheckoutEnabled.mockResolvedValue(true);
    mockWorktreeManager.ensurePRDirectoriesInSparseCheckout.mockResolvedValue(['src']);

    await setupStackPR(defaultParams());

    expect(mockWorktreeManager.isSparseCheckoutEnabled)
      .toHaveBeenCalledWith('/tmp/worktree/test-repo');
    expect(mockWorktreeManager.ensurePRDirectoriesInSparseCheckout)
      .toHaveBeenCalledWith('/tmp/worktree/test-repo', fakePRFiles);
  });

  it('expands the sparse cone BEFORE generating the diff (downstream disk reads)', async () => {
    mockWorktreeManager.isSparseCheckoutEnabled.mockResolvedValue(true);
    const callOrder = [];
    mockWorktreeManager.ensurePRDirectoriesInSparseCheckout.mockImplementation(async () => {
      callOrder.push('expand');
      return ['src'];
    });
    mockWorktreeManager.generateUnifiedDiff.mockImplementation(async () => {
      callOrder.push('diff');
      return 'diff';
    });

    await setupStackPR(defaultParams());

    expect(callOrder).toEqual(['expand', 'diff']);
  });

  it('does NOT expand sparse-checkout when a checkout script is configured (script owns the cone)', async () => {
    mockWorktreeManager.isSparseCheckoutEnabled.mockResolvedValue(true);

    await setupStackPR({ ...defaultParams(), checkoutScript: '/scripts/checkout.sh' });

    // The script owns sparse-checkout setup — we must not touch it at all.
    expect(mockWorktreeManager.isSparseCheckoutEnabled).not.toHaveBeenCalled();
    expect(mockWorktreeManager.ensurePRDirectoriesInSparseCheckout).not.toHaveBeenCalled();
  });

  it('skips expansion when the worktree is not sparse', async () => {
    mockWorktreeManager.isSparseCheckoutEnabled.mockResolvedValue(false);

    await setupStackPR(defaultParams());

    expect(mockWorktreeManager.isSparseCheckoutEnabled).toHaveBeenCalled();
    expect(mockWorktreeManager.ensurePRDirectoriesInSparseCheckout).not.toHaveBeenCalled();
  });

  it('skips expansion when the PR has no changed files', async () => {
    vi.spyOn(clientModule.GitHubClient.prototype, 'fetchPullRequestFiles')
      .mockResolvedValue([]);
    mockWorktreeManager.isSparseCheckoutEnabled.mockResolvedValue(true);

    await setupStackPR(defaultParams());

    expect(mockWorktreeManager.isSparseCheckoutEnabled).not.toHaveBeenCalled();
    expect(mockWorktreeManager.ensurePRDirectoriesInSparseCheckout).not.toHaveBeenCalled();
  });

  it('treats a sparse-checkout expansion failure as non-fatal', async () => {
    mockWorktreeManager.isSparseCheckoutEnabled.mockResolvedValue(true);
    mockWorktreeManager.ensurePRDirectoriesInSparseCheckout
      .mockRejectedValue(new Error('sparse-checkout add failed'));

    // Setup must still complete and persist the PR despite the expansion error.
    const result = await setupStackPR(defaultParams());

    expect(result.reviewId).toBe(101);
    expect(mockWorktreeManager.generateUnifiedDiff).toHaveBeenCalled();
    expect(mockStorePRData).toHaveBeenCalled();
  });
});
