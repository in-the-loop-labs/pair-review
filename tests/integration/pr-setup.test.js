// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDatabase, closeTestDatabase } from '../utils/schema';
import path from 'path';

// ============================================================================
// Mocking Strategy
// ============================================================================
// The project uses CommonJS modules, and pr-setup.js destructures imports at
// module load time (e.g., `const { getMonorepoPath } = require('../config')`).
// This means the destructured variables capture whichever function is on the
// module exports object at the time pr-setup.js is first require()'d.
//
// To intercept these, we must install spies BEFORE pr-setup.js is loaded.
// We use vi.spyOn() at the top level (not in beforeEach) so the spied
// functions are already in place when pr-setup.js destructures them.
//
// Note: findRepositoryPath accepts `config` as a parameter (rather than
// calling loadConfig() internally), so we pass testConfig directly in tests.
//
// IMPORTANT: Do NOT call vi.restoreAllMocks() because that would replace the
// spied functions with the originals, breaking the interception for subsequent
// tests. Instead, use vi.clearAllMocks() to reset call history and mock
// implementations between tests.
//
// For simple-git, which is also captured at module load time, we use real git
// directory paths (the test repo itself) for success cases and non-existent
// paths for failure cases (caught by the production code's try-catch blocks).

const configModule = require('../../src/config');
const localReview = require('../../src/local-review');
const { GitWorktreeManager } = require('../../src/git/worktree');
const { RepoSettingsRepository } = require('../../src/database');

// Install spies BEFORE pr-setup.js is loaded so that its destructured
// variables capture the spy wrappers, not the original functions.
vi.spyOn(configModule, 'getConfigDir');
vi.spyOn(configModule, 'getMonorepoPath');
vi.spyOn(configModule, 'getMonorepoCheckoutScript');
vi.spyOn(configModule, 'getMonorepoWorktreeDirectory');
vi.spyOn(configModule, 'getMonorepoWorktreeNameTemplate');
vi.spyOn(localReview, 'findMainGitRoot');
vi.spyOn(GitWorktreeManager.prototype, 'pathExists');

// NOW load pr-setup.js - its destructured variables will capture our spies
const { findRepositoryPath } = require('../../src/setup/pr-setup');

// The test repo root is a real git directory we can use for success cases
const TEST_REPO_ROOT = path.resolve(__dirname, '../..');

// ============================================================================
// findRepositoryPath Integration Tests - Monorepo Configuration
// ============================================================================

describe('findRepositoryPath with monorepo configuration', () => {
  let db;
  let testConfig;

  beforeEach(async () => {
    db = await createTestDatabase();

    // Reset mock implementations (but keep the spies installed)
    vi.clearAllMocks();

    // Default config object passed directly to findRepositoryPath
    testConfig = { github_token: 'test-token', monorepos: {} };

    configModule.getConfigDir.mockReturnValue('/tmp/.pair-review-test');
    configModule.getMonorepoPath.mockReturnValue(null);
    configModule.getMonorepoCheckoutScript.mockReturnValue(null);
    configModule.getMonorepoWorktreeDirectory.mockReturnValue(null);
    configModule.getMonorepoWorktreeNameTemplate.mockReturnValue(null);

    // Default: findMainGitRoot rejects
    localReview.findMainGitRoot.mockRejectedValue(new Error('Not a git repo'));

    // Default: no paths exist on disk
    GitWorktreeManager.prototype.pathExists.mockResolvedValue(false);
  });

  afterEach(async () => {
    // Do NOT call vi.restoreAllMocks() - that would remove the spy wrappers
    // that pr-setup.js has already captured via destructuring.
    if (db) {
      await closeTestDatabase(db);
    }
  });

  // Helper to make specific paths "exist" for pathExists checks
  function makePathsExist(paths) {
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => {
      return paths.includes(p);
    });
  }

  it('should use monorepo path (Tier -1) over repo_settings known path (Tier 0)', async () => {
    const knownDbPath = '/home/user/repos/my-repo';

    // Configure Tier -1: monorepo config points to the real test repo
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`, knownDbPath]);

    // Configure Tier 0: register a known path in the database
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', knownDbPath);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // Tier -1 (monorepo) should win over Tier 0 (known path)
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    // knownPath should still be reported from the database
    expect(result.knownPath).toBe(knownDbPath);
  });

  it('should set worktreeSourcePath when monorepo path resolves to a different root', async () => {
    const configuredWorktreePath = '/workspace/monorepo-worktree';

    // The configured path is a worktree that resolves to the real repo root
    // (simulating a worktree -> main repo resolution)
    configModule.getMonorepoPath.mockReturnValue(configuredWorktreePath);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // repositoryPath should be the resolved main root
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    // worktreeSourcePath should be the original configured path (for sparse-checkout inheritance)
    expect(result.worktreeSourcePath).toBe(configuredWorktreePath);
  });

  it('should not set worktreeSourcePath when monorepo path is the main root itself', async () => {
    // Configured path IS the main root (no worktree resolution difference)
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should fall back to Tier 0 when monorepo path does not exist', async () => {
    const invalidMonorepoPath = '/nonexistent/monorepo';

    // Tier -1: monorepo path is configured but findMainGitRoot rejects
    configModule.getMonorepoPath.mockReturnValue(invalidMonorepoPath);
    localReview.findMainGitRoot.mockRejectedValue(new Error('Path does not exist'));

    // Tier 0: known path in the database is valid (use real repo root)
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', TEST_REPO_ROOT);

    makePathsExist([TEST_REPO_ROOT]);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // Monorepo path failed, so Tier 0 (known path) should be used
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.knownPath).toBe(TEST_REPO_ROOT);
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should fall back to Tier 0 when monorepo path resolves but git commands fail', async () => {
    const monorepoPath = '/workspace/broken-monorepo';

    // Tier -1: monorepo path resolves but to a non-existent directory,
    // so simpleGit(resolvedPath).revparse(['HEAD']) will fail
    configModule.getMonorepoPath.mockReturnValue(monorepoPath);
    localReview.findMainGitRoot.mockResolvedValue(monorepoPath);

    makePathsExist([`${monorepoPath}/.git`, TEST_REPO_ROOT]);

    // Set up Tier 0 known path (real repo so simpleGit succeeds)
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', TEST_REPO_ROOT);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // Monorepo git commands failed (non-existent path), should fall back to Tier 0
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should fall back to Tier 0 when monorepo path has no .git directory or HEAD file', async () => {
    const monorepoPath = '/workspace/not-a-repo';

    // Tier -1: monorepo path resolves, but pathExists returns false for .git and HEAD
    configModule.getMonorepoPath.mockReturnValue(monorepoPath);
    localReview.findMainGitRoot.mockResolvedValue(monorepoPath);

    // Only the known DB path exists; monorepo path has neither .git nor HEAD
    makePathsExist([TEST_REPO_ROOT]);

    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath('owner/repo', TEST_REPO_ROOT);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // No valid git structure at monorepo path, should fall back to Tier 0
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should handle bare repo at monorepo path (HEAD file without .git directory)', async () => {
    // Use the real test repo; findMainGitRoot resolves to it and
    // simpleGit can run revparse successfully
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    // Simulate bare repo: HEAD exists but .git does not
    GitWorktreeManager.prototype.pathExists.mockImplementation(async (p) => {
      if (p === `${TEST_REPO_ROOT}/.git`) return false;
      if (p === `${TEST_REPO_ROOT}/HEAD`) return true;
      return false;
    });

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should report knownPath as null when no path is registered in repo_settings', async () => {
    // Configure Tier -1 to succeed
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // Do NOT register any known path in the database

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.knownPath).toBeNull();
  });

  it('should return checkoutScript when configured, with worktreeSourcePath nullified', async () => {
    const configuredWorktreePath = '/workspace/monorepo-worktree';

    // Tier -1: monorepo path resolves through a worktree
    configModule.getMonorepoPath.mockReturnValue(configuredWorktreePath);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // checkout_script is configured
    configModule.getMonorepoCheckoutScript.mockReturnValue('./scripts/pr-checkout.sh');

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.checkoutScript).toBe('./scripts/pr-checkout.sh');
    // worktreeSourcePath should be nullified when checkoutScript is set
    // (even though monorepo path differs from resolved root)
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should return null checkoutScript when not configured (existing behavior preserved)', async () => {
    // Tier -1: monorepo path resolves directly to main root
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // No checkout_script configured
    configModule.getMonorepoCheckoutScript.mockReturnValue(null);

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.checkoutScript).toBeNull();
    expect(result.worktreeSourcePath).toBeNull();
  });

  it('should nullify worktreeSourcePath when checkoutScript is set even with different monorepo path', async () => {
    const configuredWorktreePath = '/workspace/different-worktree';

    // Monorepo path differs from resolved root (would normally set worktreeSourcePath)
    configModule.getMonorepoPath.mockReturnValue(configuredWorktreePath);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // But checkout_script is also configured
    configModule.getMonorepoCheckoutScript.mockReturnValue('./checkout.sh');

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    // checkoutScript is set, so worktreeSourcePath must be null
    expect(result.checkoutScript).toBe('./checkout.sh');
    expect(result.worktreeSourcePath).toBeNull();
    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
  });

  it('should return worktreeConfig with worktreeBaseDir and nameTemplate when both are configured', async () => {
    // Tier -1: monorepo path resolves directly to main root
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // Configure checkout_script alongside worktree options
    configModule.getMonorepoCheckoutScript.mockReturnValue('./scripts/pr-checkout.sh');
    configModule.getMonorepoWorktreeDirectory.mockReturnValue('/custom/worktrees');
    configModule.getMonorepoWorktreeNameTemplate.mockReturnValue('{owner}-{repo}-pr-{pr_number}');

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.repositoryPath).toBe(TEST_REPO_ROOT);
    expect(result.checkoutScript).toBe('./scripts/pr-checkout.sh');
    expect(result.worktreeConfig).toEqual({
      worktreeBaseDir: '/custom/worktrees',
      nameTemplate: '{owner}-{repo}-pr-{pr_number}'
    });
  });

  it('should return worktreeConfig with only worktreeBaseDir when nameTemplate is not configured', async () => {
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    configModule.getMonorepoWorktreeDirectory.mockReturnValue('/custom/worktrees');
    // nameTemplate left as default (null)

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.worktreeConfig).toEqual({
      worktreeBaseDir: '/custom/worktrees'
    });
  });

  it('should return worktreeConfig with only nameTemplate when worktreeBaseDir is not configured', async () => {
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    configModule.getMonorepoWorktreeNameTemplate.mockReturnValue('{owner}-{repo}-pr-{pr_number}');
    // worktreeDirectory left as default (null)

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.worktreeConfig).toEqual({
      nameTemplate: '{owner}-{repo}-pr-{pr_number}'
    });
  });

  it('should return null worktreeConfig when neither worktreeDirectory nor nameTemplate are configured', async () => {
    configModule.getMonorepoPath.mockReturnValue(TEST_REPO_ROOT);
    localReview.findMainGitRoot.mockResolvedValue(TEST_REPO_ROOT);
    makePathsExist([`${TEST_REPO_ROOT}/.git`]);

    // Both left as default (null)

    const result = await findRepositoryPath({
      db,
      owner: 'owner',
      repo: 'repo',
      repository: 'owner/repo',
      prNumber: 42,
      config: testConfig
    });

    expect(result.worktreeConfig).toBeNull();
  });
});
