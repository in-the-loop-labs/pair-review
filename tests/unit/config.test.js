// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { deepMerge, getGitHubToken, expandPath, resolveDbName, warnIfDevModeWithoutDbName, loadConfig, shouldSkipUpdateNotifier, _resetTokenCache, getRepoConfig, getRepoPath, getRepoCheckoutScript, getRepoWorktreeDirectory, getRepoWorktreeNameTemplate, getRepoCheckoutTimeout, resolveRepoOptions, getRepoResetScript, getRepoSkipBulkFetch, getRepoPoolSize, getRepoPoolFetchInterval, resolvePoolConfig, getWorktreeDisplayName, getConfigDir, getRepoLoadSkills, resolveLoadSkills, buildCouncilProviderOverrides, getSummaryProvider, getSummaryModel, getTourProvider, getTourModel, getSummaryEnabled, getSummaryAutoGenerate, getTourEnabled, getTourAutoGenerate, resolveHostBinding, validateRepoConfig, matchRepoByUrl, resolveBindingRepositoryFromPR } = require('../../src/config');

describe('config.js', () => {
  describe('getGitHubToken', () => {
    let originalEnv;

    beforeEach(() => {
      // Save original environment
      originalEnv = process.env.GITHUB_TOKEN;
      // Clear the env var before each test
      delete process.env.GITHUB_TOKEN;
    });

    afterEach(() => {
      // Restore original environment
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    });

    it('should return GITHUB_TOKEN env var when set', () => {
      process.env.GITHUB_TOKEN = 'env_token_123';
      const config = { github_token: 'config_token_456' };

      const result = getGitHubToken(config);

      expect(result).toBe('env_token_123');
    });

    it('should fall back to config.github_token when env var is not set', () => {
      const config = { github_token: 'config_token_456' };

      const result = getGitHubToken(config);

      expect(result).toBe('config_token_456');
    });

    it('should return empty string when neither env var nor config is set', () => {
      const config = {};

      const result = getGitHubToken(config);

      expect(result).toBe('');
    });

    it('should return empty string when config.github_token is empty', () => {
      const config = { github_token: '' };

      const result = getGitHubToken(config);

      expect(result).toBe('');
    });

    it('should prefer env var over config even when both are set', () => {
      process.env.GITHUB_TOKEN = 'env_wins';
      const config = { github_token: 'config_loses' };

      const result = getGitHubToken(config);

      expect(result).toBe('env_wins');
    });

    it('should handle undefined config.github_token', () => {
      const config = { github_token: undefined };

      const result = getGitHubToken(config);

      expect(result).toBe('');
    });

    it('should handle null config.github_token', () => {
      const config = { github_token: null };

      const result = getGitHubToken(config);

      expect(result).toBe('');
    });

    it('should return env var when config.github_token is undefined', () => {
      process.env.GITHUB_TOKEN = 'env_token';
      const config = { github_token: undefined };

      const result = getGitHubToken(config);

      expect(result).toBe('env_token');
    });
  });

  describe('github_token_command', () => {
    let originalEnv;
    let execSyncSpy;
    let warnSpy;

    beforeEach(() => {
      originalEnv = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      _resetTokenCache();
      execSyncSpy = vi.spyOn(childProcess, 'execSync');
      const logger = require('../../src/utils/logger');
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
      _resetTokenCache();
      execSyncSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should return trimmed token from command', () => {
      execSyncSpy.mockReturnValue('ghp_abc123\n');
      const config = { github_token_command: 'gh auth token' };

      const result = getGitHubToken(config);

      expect(result).toBe('ghp_abc123');
      expect(execSyncSpy).toHaveBeenCalledWith('gh auth token', {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    });

    it('should return empty string and log warning with error details when command fails', () => {
      execSyncSpy.mockImplementation(() => { throw new Error('command not found'); });
      const config = { github_token_command: 'bad-command' };

      const result = getGitHubToken(config);

      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('github_token_command failed'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('command not found'));
    });

    it('should return empty string and log warning with error details on timeout', () => {
      const err = new Error('ETIMEDOUT');
      err.killed = true;
      execSyncSpy.mockImplementation(() => { throw err; });
      const config = { github_token_command: 'sleep 999' };

      const result = getGitHubToken(config);

      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('github_token_command failed'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'));
    });

    it('should return empty string and log warning when command returns whitespace only', () => {
      execSyncSpy.mockReturnValue('  \n  \n');
      const config = { github_token_command: 'echo ""' };

      const result = getGitHubToken(config);

      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did not produce a token'));
    });

    it('should prefer env var over command', () => {
      process.env.GITHUB_TOKEN = 'env_token';
      execSyncSpy.mockReturnValue('cmd_token\n');
      const config = { github_token_command: 'gh auth token' };

      const result = getGitHubToken(config);

      expect(result).toBe('env_token');
      expect(execSyncSpy).not.toHaveBeenCalled();
    });

    it('should prefer config literal over command', () => {
      execSyncSpy.mockReturnValue('cmd_token\n');
      const config = { github_token: 'literal_token', github_token_command: 'gh auth token' };

      const result = getGitHubToken(config);

      expect(result).toBe('literal_token');
      expect(execSyncSpy).not.toHaveBeenCalled();
    });

    it('should cache result and only call execSync once', () => {
      execSyncSpy.mockReturnValue('ghp_cached\n');
      const config = { github_token_command: 'gh auth token' };

      const result1 = getGitHubToken(config);
      const result2 = getGitHubToken(config);

      expect(result1).toBe('ghp_cached');
      expect(result2).toBe('ghp_cached');
      expect(execSyncSpy).toHaveBeenCalledTimes(1);
    });

    it('should not cache failures — retry on next call', () => {
      execSyncSpy.mockImplementationOnce(() => { throw new Error('not found'); });
      execSyncSpy.mockReturnValueOnce('ghp_retry_success\n');
      const config = { github_token_command: 'gh auth token' };

      const result1 = getGitHubToken(config);
      const result2 = getGitHubToken(config);

      expect(result1).toBe('');
      expect(result2).toBe('ghp_retry_success');
      expect(execSyncSpy).toHaveBeenCalledTimes(2);
    });

    it('should not cache empty output — retry on next call', () => {
      execSyncSpy.mockReturnValueOnce('  \n');
      execSyncSpy.mockReturnValueOnce('ghp_now_works\n');
      const config = { github_token_command: 'gh auth token' };

      const result1 = getGitHubToken(config);
      const result2 = getGitHubToken(config);

      expect(result1).toBe('');
      expect(result2).toBe('ghp_now_works');
      expect(execSyncSpy).toHaveBeenCalledTimes(2);
    });

    it('should execute the exact custom command string', () => {
      execSyncSpy.mockReturnValue('op_token\n');
      const config = { github_token_command: 'op read op://vault/github/token' };

      getGitHubToken(config);

      expect(execSyncSpy).toHaveBeenCalledWith('op read op://vault/github/token', expect.any(Object));
    });

    it('should not call execSync when github_token_command is absent or empty', () => {
      expect(getGitHubToken({})).toBe('');
      expect(getGitHubToken({ github_token_command: '' })).toBe('');
      expect(execSyncSpy).not.toHaveBeenCalled();
    });
  });

  describe('expandPath', () => {
    it('should expand paths starting with ~/', () => {
      const result = expandPath('~/some/path');
      expect(result).toBe(`${os.homedir()}/some/path`);
    });

    it('should return absolute paths unchanged', () => {
      const result = expandPath('/absolute/path/to/repo');
      expect(result).toBe('/absolute/path/to/repo');
    });

    it('should return relative paths unchanged', () => {
      const result = expandPath('relative/path');
      expect(result).toBe('relative/path');
    });

    it('should return null for null input', () => {
      const result = expandPath(null);
      expect(result).toBe(null);
    });

    it('should return undefined for undefined input', () => {
      const result = expandPath(undefined);
      expect(result).toBe(undefined);
    });

    it('should return empty string for empty string input', () => {
      const result = expandPath('');
      expect(result).toBe('');
    });

    it('should expand bare ~ to home directory', () => {
      const result = expandPath('~');
      expect(result).toBe(os.homedir());
    });

    it('should handle paths with ~ in the middle', () => {
      const result = expandPath('/path/with~/tilde');
      expect(result).toBe('/path/with~/tilde');
    });
  });

  describe('getRepoPath (legacy monorepos key)', () => {
    it('should return expanded path for configured repository via monorepos key', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/monorepos/my-repo' }
        }
      };

      const result = getRepoPath(config, 'owner/repo');
      expect(result).toBe(`${os.homedir()}/monorepos/my-repo`);
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { path: '~/other' }
        }
      };

      const result = getRepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no repos or monorepos', () => {
      const config = {};

      const result = getRepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when only unrelated keys exist', () => {
      const config = { github_token: 'token' };

      const result = getRepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when repo config has no path', () => {
      const config = {
        monorepos: {
          'owner/repo': { description: 'no path here' }
        }
      };

      const result = getRepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should handle absolute paths without expansion', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '/absolute/path/to/repo' }
        }
      };

      const result = getRepoPath(config, 'owner/repo');
      expect(result).toBe('/absolute/path/to/repo');
    });
  });

  describe('getRepoCheckoutScript (legacy monorepos key)', () => {
    it('should return checkout script for configured repository via monorepos key', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_script: './scripts/pr-checkout.sh' }
        }
      };

      const result = getRepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe('./scripts/pr-checkout.sh');
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { checkout_script: './scripts/other.sh' }
        }
      };

      const result = getRepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when repo config has no checkout_script', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getRepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no repos or monorepos', () => {
      const config = {};

      const result = getRepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe(null);
    });
  });

  describe('getRepoWorktreeDirectory (legacy monorepos key)', () => {
    it('should return expanded path for configured repository via monorepos key', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_directory: '~/custom/worktrees' }
        }
      };

      const result = getRepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(`${os.homedir()}/custom/worktrees`);
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { worktree_directory: '~/other/worktrees' }
        }
      };

      const result = getRepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when repo config has no worktree_directory', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getRepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no repos or monorepos', () => {
      const config = {};

      const result = getRepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should handle absolute paths without expansion', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_directory: '/absolute/worktrees' }
        }
      };

      const result = getRepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe('/absolute/worktrees');
    });
  });

  describe('getRepoWorktreeNameTemplate (legacy monorepos key)', () => {
    it('should return template for configured repository via monorepos key', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_name_template: '{id}/src' }
        }
      };

      const result = getRepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe('{id}/src');
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { worktree_name_template: '{id}' }
        }
      };

      const result = getRepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when repo config has no worktree_name_template', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getRepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no repos or monorepos', () => {
      const config = {};

      const result = getRepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return complex templates with multiple variables', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_name_template: 'pr-{pr_number}/{owner}-{repo}/{id}' }
        }
      };

      const result = getRepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe('pr-{pr_number}/{owner}-{repo}/{id}');
    });
  });

  describe('getRepoCheckoutTimeout (legacy monorepos key)', () => {
    it('should return configured value converted to milliseconds via monorepos key', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_timeout_seconds: 120 }
        }
      };

      const result = getRepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(120000);
    });

    it('should return default 300000 when not configured', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getRepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when monorepos section does not have the repo', () => {
      const config = {
        monorepos: {
          'other/repo': { checkout_timeout_seconds: 60 }
        }
      };

      const result = getRepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when config has no repos or monorepos', () => {
      const config = {};

      const result = getRepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when checkout_timeout_seconds is 0 (falsy)', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_timeout_seconds: 0 }
        }
      };

      const result = getRepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when checkout_timeout_seconds is negative', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_timeout_seconds: -10 }
        }
      };

      // Negative values are now correctly rejected by the > 0 guard
      const result = getRepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });
  });

  describe('resolveRepoOptions (legacy monorepos key)', () => {
    it('should return null for both when no repo config exists', () => {
      const config = {};

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe(null);
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toBe(null);
    });

    it('should return checkoutScript when only checkout_script is configured via monorepos key', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_script: './scripts/checkout.sh' }
        }
      };

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe('./scripts/checkout.sh');
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toBe(null);
    });

    it('should return worktreeConfig with worktreeBaseDir when only worktree_directory is configured', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_directory: '~/custom/worktrees' }
        }
      };

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe(null);
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toEqual({
        worktreeBaseDir: `${os.homedir()}/custom/worktrees`
      });
    });

    it('should return worktreeConfig with nameTemplate when only worktree_name_template is configured', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_name_template: 'pr-{pr_number}/{id}' }
        }
      };

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe(null);
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toEqual({
        nameTemplate: 'pr-{pr_number}/{id}'
      });
    });

    it('should return worktreeConfig with both properties when worktree_directory and worktree_name_template are configured', () => {
      const config = {
        monorepos: {
          'owner/repo': {
            worktree_directory: '/abs/worktrees',
            worktree_name_template: '{id}/src'
          }
        }
      };

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe(null);
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toEqual({
        worktreeBaseDir: '/abs/worktrees',
        nameTemplate: '{id}/src'
      });
    });

    it('should return all values when checkout_script, worktree_directory, and worktree_name_template are all configured', () => {
      const config = {
        monorepos: {
          'owner/repo': {
            checkout_script: './scripts/pr-checkout.sh',
            worktree_directory: '~/mono/worktrees',
            worktree_name_template: 'pr-{pr_number}'
          }
        }
      };

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe('./scripts/pr-checkout.sh');
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toEqual({
        worktreeBaseDir: `${os.homedir()}/mono/worktrees`,
        nameTemplate: 'pr-{pr_number}'
      });
    });

    it('should return custom checkoutTimeout when checkout_timeout_seconds is configured', () => {
      const config = {
        monorepos: {
          'owner/repo': {
            checkout_script: './scripts/pr-checkout.sh',
            checkout_timeout_seconds: 600
          }
        }
      };

      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe('./scripts/pr-checkout.sh');
      expect(result.checkoutTimeout).toBe(600000);
      expect(result.worktreeConfig).toBe(null);
    });
  });

  describe('resolveDbName', () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = process.env.PAIR_REVIEW_DB_NAME;
      delete process.env.PAIR_REVIEW_DB_NAME;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.PAIR_REVIEW_DB_NAME = originalEnv;
      } else {
        delete process.env.PAIR_REVIEW_DB_NAME;
      }
    });

    it('should return PAIR_REVIEW_DB_NAME env var when set', () => {
      process.env.PAIR_REVIEW_DB_NAME = 'env-db.db';
      const config = { db_name: 'config-db.db' };

      const result = resolveDbName(config);

      expect(result).toBe('env-db.db');
    });

    it('should fall back to config.db_name when env var is not set', () => {
      const config = { db_name: 'config-db.db' };

      const result = resolveDbName(config);

      expect(result).toBe('config-db.db');
    });

    it('should return database.db when neither env var nor config is set', () => {
      const config = {};

      const result = resolveDbName(config);

      expect(result).toBe('database.db');
    });

    it('should return database.db when config.db_name is empty string', () => {
      const config = { db_name: '' };

      const result = resolveDbName(config);

      expect(result).toBe('database.db');
    });

    it('should prefer env var over config when both are set', () => {
      process.env.PAIR_REVIEW_DB_NAME = 'env-wins.db';
      const config = { db_name: 'config-loses.db' };

      const result = resolveDbName(config);

      expect(result).toBe('env-wins.db');
    });
  });

  describe('warnIfDevModeWithoutDbName', () => {
    let originalEnv;
    let warnSpy;

    beforeEach(() => {
      originalEnv = process.env.PAIR_REVIEW_DB_NAME;
      delete process.env.PAIR_REVIEW_DB_NAME;
      const logger = require('../../src/utils/logger');
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.PAIR_REVIEW_DB_NAME = originalEnv;
      } else {
        delete process.env.PAIR_REVIEW_DB_NAME;
      }
      warnSpy.mockRestore();
    });

    it('should warn when dev_mode is true and no db_name is configured', () => {
      warnIfDevModeWithoutDbName({ dev_mode: true });

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('dev_mode');
    });

    it('should not warn when dev_mode is false', () => {
      warnIfDevModeWithoutDbName({ dev_mode: false });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should not warn when dev_mode is true but db_name is set in config', () => {
      warnIfDevModeWithoutDbName({ dev_mode: true, db_name: 'dev.db' });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should not warn when dev_mode is true but PAIR_REVIEW_DB_NAME env var is set', () => {
      process.env.PAIR_REVIEW_DB_NAME = 'env.db';
      warnIfDevModeWithoutDbName({ dev_mode: true });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should not warn when dev_mode is not set', () => {
      warnIfDevModeWithoutDbName({});

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('deepMerge', () => {
    it('should override scalar values', () => {
      const result = deepMerge({ a: 1 }, { a: 2 });
      expect(result).toEqual({ a: 2 });
    });

    it('should add new keys from source', () => {
      const result = deepMerge({ a: 1 }, { b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should recursively merge nested objects', () => {
      const result = deepMerge(
        { nested: { a: 1, b: 2 } },
        { nested: { b: 3, c: 4 } }
      );
      expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
    });

    it('should merge 3 levels deep', () => {
      const result = deepMerge(
        { l1: { l2: { l3: 'old', keep: true } } },
        { l1: { l2: { l3: 'new' } } }
      );
      expect(result).toEqual({ l1: { l2: { l3: 'new', keep: true } } });
    });

    it('should replace arrays instead of concatenating', () => {
      const result = deepMerge(
        { arr: [1, 2, 3] },
        { arr: [4, 5] }
      );
      expect(result).toEqual({ arr: [4, 5] });
    });

    it('should allow null in source to overwrite target', () => {
      const result = deepMerge({ a: { nested: true } }, { a: null });
      expect(result).toEqual({ a: null });
    });

    it('should return target unchanged when source is undefined', () => {
      const target = { a: 1 };
      const result = deepMerge(target, undefined);
      expect(result).toEqual({ a: 1 });
    });

    it('should return target unchanged when source is empty object', () => {
      const target = { a: 1, b: { c: 2 } };
      const result = deepMerge(target, {});
      expect(result).toEqual({ a: 1, b: { c: 2 } });
    });

    it('should not mutate either input', () => {
      const target = { a: { b: 1 } };
      const source = { a: { c: 2 } };
      const result = deepMerge(target, source);
      expect(target).toEqual({ a: { b: 1 } });
      expect(source).toEqual({ a: { c: 2 } });
      expect(result).toEqual({ a: { b: 1, c: 2 } });
    });
  });

  describe('loadConfig', () => {
    const MANAGED_CONFIG_PATH = path.join(__dirname, '..', '..', 'config.managed.json');
    const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.pair-review', 'config.json');
    const GLOBAL_LOCAL_CONFIG_PATH = path.join(os.homedir(), '.pair-review', 'config.local.json');
    const PROJECT_CONFIG_PATH = path.join(process.cwd(), '.pair-review', 'config.json');
    const PROJECT_LOCAL_CONFIG_PATH = path.join(process.cwd(), '.pair-review', 'config.local.json');

    let readFileSpy;
    let accessSpy;
    let mkdirSpy;
    let writeFileSpy;
    let copyFileSpy;

    beforeEach(() => {
      // Spy on fs.promises methods (the same object config.js captured at load time)
      accessSpy = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
      mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
      writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
      copyFileSpy = vi.spyOn(fs.promises, 'copyFile').mockResolvedValue(undefined);
      readFileSpy = vi.spyOn(fs.promises, 'readFile');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * @param {Object} opts
     * @param {Object|null} opts.global - Global config.json content (null = ENOENT)
     * @param {Object|null} [opts.managed] - Managed config.managed.json content (null = ENOENT)
     * @param {Object|null} [opts.globalLocal] - Global config.local.json content (null = ENOENT)
     * @param {Object|null} [opts.project] - Project config.json content (null = ENOENT)
     * @param {Object|null} [opts.projectLocal] - Project config.local.json content (null = ENOENT)
     */
    function mockReadFile({ managed = null, global: globalJson, globalLocal = null, project = null, projectLocal = null }) {
      const fileMap = {
        [MANAGED_CONFIG_PATH]: managed,
        [GLOBAL_CONFIG_PATH]: globalJson,
        [GLOBAL_LOCAL_CONFIG_PATH]: globalLocal,
        [PROJECT_CONFIG_PATH]: project,
        [PROJECT_LOCAL_CONFIG_PATH]: projectLocal,
      };
      readFileSpy.mockImplementation(async (filePath) => {
        if (filePath in fileMap) {
          const content = fileMap[filePath];
          if (content === null) {
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            throw err;
          }
          return JSON.stringify(content);
        }
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });
    }

    it('should deep-merge global config partial chat object with defaults', async () => {
      mockReadFile({
        global: { port: 7247, chat: { enable_shortcuts: false } },
      });

      const { config } = await loadConfig();

      expect(config.chat).toEqual({ enable_shortcuts: false, enter_to_send: true });
    });

    it('should three-way merge defaults, global, and project for nested objects', async () => {
      mockReadFile({
        global: { port: 7247, chat: { enable_shortcuts: false } },
        project: { chat: { some_future_key: true } },
      });

      const { config } = await loadConfig();

      expect(config.chat).toEqual({ enable_shortcuts: false, enter_to_send: true, some_future_key: true });
    });

    it('should let project config override global for the same nested key', async () => {
      mockReadFile({
        global: { chat: { enable_shortcuts: false } },
        project: { chat: { enable_shortcuts: true } },
      });

      const { config } = await loadConfig();

      expect(config.chat.enable_shortcuts).toBe(true);
    });

    it('should include assisted_by_url in default config', async () => {
      mockReadFile({
        global: { port: 7247 },
      });

      const { config } = await loadConfig();

      expect(config.assisted_by_url).toBe('https://github.com/in-the-loop-labs/pair-review');
    });

    it('should preserve object defaults when config only has scalar keys', async () => {
      mockReadFile({
        global: { port: 8080, theme: 'dark' },
      });

      const { config } = await loadConfig();

      expect(config.chat).toEqual({ enable_shortcuts: true, enter_to_send: true });
    });

    // --- config.local.json tests ---

    it('should let global local config override global config', async () => {
      mockReadFile({
        global: { port: 7247, theme: 'light' },
        globalLocal: { theme: 'dark', yolo: true },
      });

      const { config } = await loadConfig();

      expect(config.theme).toBe('dark');
      expect(config.yolo).toBe(true);
      expect(config.port).toBe(7247);
    });

    it('should let project local config override project config', async () => {
      mockReadFile({
        global: { port: 7247 },
        project: { default_provider: 'gemini' },
        projectLocal: { default_provider: 'claude' },
      });

      const { config } = await loadConfig();

      expect(config.default_provider).toBe('claude');
    });

    it('should apply full 4-layer precedence (project local wins over all)', async () => {
      mockReadFile({
        global: { theme: 'global', port: 1111 },
        globalLocal: { theme: 'global-local', port: 2222 },
        project: { theme: 'project', port: 3333 },
        projectLocal: { theme: 'project-local' },
      });

      const { config } = await loadConfig();

      expect(config.theme).toBe('project-local');
      expect(config.port).toBe(3333);  // project wins over global-local, projectLocal didn't set port
    });

    it('should deep-merge nested objects across all 4 layers', async () => {
      mockReadFile({
        global: { chat: { a: 'global' }, providers: { x: { model: 'g' } } },
        globalLocal: { chat: { b: 'global-local' } },
        project: { chat: { c: 'project' }, providers: { x: { timeout: 5 } } },
        projectLocal: { chat: { d: 'project-local' } },
      });

      const { config } = await loadConfig();

      expect(config.chat).toEqual({
        enable_shortcuts: true,  // from DEFAULT_CONFIG
        enter_to_send: true,     // from DEFAULT_CONFIG
        a: 'global',
        b: 'global-local',
        c: 'project',
        d: 'project-local',
      });
      expect(config.providers.x).toEqual({ model: 'g', timeout: 5 });
    });

    it('should skip missing local config files silently', async () => {
      mockReadFile({
        global: { port: 7247 },
        // globalLocal, project, projectLocal all default to null (ENOENT)
      });

      const { config } = await loadConfig();

      expect(config.port).toBe(7247);
    });

    // --- managed config tests ---

    it('should apply managed config values between defaults and global config', async () => {
      mockReadFile({
        managed: { default_provider: 'gemini', theme: 'dark' },
        global: { port: 7247 },
      });

      const { config } = await loadConfig();

      expect(config.default_provider).toBe('gemini');
      expect(config.theme).toBe('dark');
      expect(config.port).toBe(7247);
    });

    it('should let global config override managed config', async () => {
      mockReadFile({
        managed: { default_provider: 'gemini' },
        global: { default_provider: 'claude', port: 7247 },
      });

      const { config } = await loadConfig();

      expect(config.default_provider).toBe('claude');
    });

    it('should deep-merge managed config nested objects with defaults', async () => {
      mockReadFile({
        managed: { chat: { enable_shortcuts: false }, providers: { corp: { command: 'corp-ai' } } },
        global: { port: 7247 },
      });

      const { config } = await loadConfig();

      expect(config.chat.enable_shortcuts).toBe(false);
      expect(config.providers.corp).toEqual({ command: 'corp-ai' });
    });

    it('should apply full 5-layer precedence with managed config', async () => {
      mockReadFile({
        managed: { theme: 'managed', default_provider: 'managed-provider' },
        global: { theme: 'global', port: 1111 },
        globalLocal: { theme: 'global-local', port: 2222 },
        project: { theme: 'project', port: 3333 },
        projectLocal: { theme: 'project-local' },
      });

      const { config } = await loadConfig();

      expect(config.theme).toBe('project-local');
      expect(config.port).toBe(3333);
      expect(config.default_provider).toBe('managed-provider');  // only managed set this
    });

    it('should skip missing managed config silently', async () => {
      mockReadFile({
        // managed defaults to null (ENOENT)
        global: { port: 7247 },
      });

      const { config } = await loadConfig();

      expect(config.port).toBe(7247);
    });

    it('should skip creating global config when managed config has keys', async () => {
      mockReadFile({
        managed: { default_provider: 'gemini', theme: 'dark' },
        global: null,  // ENOENT — would normally trigger creation
      });

      const { config, isFirstRun } = await loadConfig();

      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(isFirstRun).toBe(false);
      expect(config.default_provider).toBe('gemini');
      expect(config.theme).toBe('dark');
    });

    it('should still create global config when managed config is empty object', async () => {
      mockReadFile({
        managed: {},
        global: null,  // ENOENT
      });

      const { isFirstRun } = await loadConfig();

      expect(writeFileSpy).toHaveBeenCalled();
      expect(isFirstRun).toBe(true);
    });

    it('should still create global config when managed config is missing', async () => {
      mockReadFile({
        // managed defaults to null (ENOENT)
        global: null,
      });

      const { isFirstRun } = await loadConfig();

      expect(writeFileSpy).toHaveBeenCalled();
      expect(isFirstRun).toBe(true);
    });

    it('should warn and skip malformed local config files', async () => {
      const logger = require('../../src/utils/logger');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      // Set up a custom mock that returns bad JSON for globalLocal
      readFileSpy.mockImplementation(async (filePath) => {
        if (filePath === GLOBAL_CONFIG_PATH) return JSON.stringify({ port: 7247 });
        if (filePath === GLOBAL_LOCAL_CONFIG_PATH) return '{ bad json';
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });

      const { config } = await loadConfig();

      expect(config.port).toBe(7247);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Malformed config'));
      warnSpy.mockRestore();
    });

    describe('PORT env var', () => {
      let originalPort;

      beforeEach(() => {
        originalPort = process.env.PORT;
        delete process.env.PORT;
      });

      afterEach(() => {
        if (originalPort !== undefined) {
          process.env.PORT = originalPort;
        } else {
          delete process.env.PORT;
        }
      });

      it('should override config.port when PORT env var is set', async () => {
        process.env.PORT = '9999';
        mockReadFile({
          global: { port: 7247 },
        });

        const { config } = await loadConfig();

        expect(config.port).toBe(9999);
      });

      it('should override all config layers including project local', async () => {
        process.env.PORT = '4242';
        mockReadFile({
          global: { port: 1111 },
          globalLocal: { port: 2222 },
          project: { port: 3333 },
          projectLocal: { port: 5555 },
        });

        const { config } = await loadConfig();

        expect(config.port).toBe(4242);
      });

      it('should use config.port when PORT env var is not set', async () => {
        mockReadFile({
          global: { port: 7247 },
        });

        const { config } = await loadConfig();

        expect(config.port).toBe(7247);
      });

      it('should coerce numeric string env value to integer', async () => {
        process.env.PORT = '8080';
        mockReadFile({
          global: { port: 7247 },
        });

        const { config } = await loadConfig();

        expect(config.port).toBe(8080);
        expect(typeof config.port).toBe('number');
      });

      it('should exit with error for non-numeric PORT env var', async () => {
        process.env.PORT = 'abc';
        mockReadFile({
          global: { port: 7247 },
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('process.exit called');
        });
        const logger = require('../../src/utils/logger');
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

        await expect(loadConfig()).rejects.toThrow('process.exit called');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid PORT env var'));

        exitSpy.mockRestore();
        errorSpy.mockRestore();
      });

      it('should exit with error for out-of-range PORT env var', async () => {
        process.env.PORT = '80';
        mockReadFile({
          global: { port: 7247 },
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('process.exit called');
        });
        const logger = require('../../src/utils/logger');
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

        await expect(loadConfig()).rejects.toThrow('process.exit called');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid PORT env var'));

        exitSpy.mockRestore();
        errorSpy.mockRestore();
      });

      it('should ignore empty string PORT env var', async () => {
        process.env.PORT = '';
        mockReadFile({
          global: { port: 7247 },
        });

        const { config } = await loadConfig();

        expect(config.port).toBe(7247);
      });
    });

    it('should normalize monorepos key into repos when only monorepos is present', async () => {
      mockReadFile({
        global: {
          port: 7247,
          monorepos: {
            'owner/repo': { path: '~/mono', pool_size: 3 }
          }
        },
      });

      const { config } = await loadConfig();

      expect(config.repos).toBeDefined();
      expect(config.repos['owner/repo']).toEqual({ path: '~/mono', pool_size: 3 });
      expect(config.monorepos).toBeUndefined();
    });

    it('should let repos values take precedence over monorepos when both exist', async () => {
      mockReadFile({
        global: {
          port: 7247,
          monorepos: {
            'owner/repo': { path: '~/mono-path', pool_size: 2 }
          },
          repos: {
            'owner/repo': { path: '~/repos-path' }
          }
        },
      });

      const { config } = await loadConfig();

      // repos value should override monorepos for the path key
      expect(config.repos['owner/repo'].path).toBe('~/repos-path');
      // monorepos pool_size should be merged in (deep merge: monorepos is base, repos overrides)
      expect(config.repos['owner/repo'].pool_size).toBe(2);
      expect(config.monorepos).toBeUndefined();
    });

    // --- external_comments feature toggle (opt-in, defaults to false) ---

    it('defaults external_comments to false when nothing sets it', async () => {
      mockReadFile({ global: { port: 7247 } });
      const { config } = await loadConfig();
      expect(config.external_comments).toBe(false);
    });

    it('respects global config opting into external_comments', async () => {
      mockReadFile({ global: { external_comments: true } });
      const { config } = await loadConfig();
      expect(config.external_comments).toBe(true);
    });

    it('lets project config override global external_comments either way', async () => {
      mockReadFile({
        global: { external_comments: true },
        project: { external_comments: false },
      });
      const { config } = await loadConfig();
      expect(config.external_comments).toBe(false);
    });

    it('should collapse case-differing monorepos and repos keys with repos taking precedence', async () => {
      mockReadFile({
        global: {
          port: 7247,
          monorepos: {
            'MyOrg/Repo': { path: '~/mono-path', pool_size: 5, reset_script: './reset.sh' }
          },
          repos: {
            'MyOrg/Repo': { path: '~/repos-path', pool_size: 0 }
          }
        },
      });

      const { config } = await loadConfig();

      expect(config.monorepos).toBeUndefined();
      expect(Object.keys(config.repos)).toEqual(['myorg/repo']);
      expect(config.repos['myorg/repo']).toEqual({
        path: '~/repos-path',
        pool_size: 0,
        reset_script: './reset.sh'
      });
    });
  });

  describe('shouldSkipUpdateNotifier', () => {
    const MANAGED_CONFIG_PATH = path.join(__dirname, '..', '..', 'config.managed.json');
    const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.pair-review', 'config.json');
    const GLOBAL_LOCAL_CONFIG_PATH = path.join(os.homedir(), '.pair-review', 'config.local.json');
    const PROJECT_CONFIG_PATH = path.join(process.cwd(), '.pair-review', 'config.json');
    const PROJECT_LOCAL_CONFIG_PATH = path.join(process.cwd(), '.pair-review', 'config.local.json');

    let readFileSyncSpy;

    beforeEach(() => {
      readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function mockReadFileSync(fileMap) {
      readFileSyncSpy.mockImplementation((filePath) => {
        if (filePath in fileMap && fileMap[filePath] !== null) {
          return JSON.stringify(fileMap[filePath]);
        }
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });
    }

    it('should return false when no config files exist', () => {
      mockReadFileSync({});
      expect(shouldSkipUpdateNotifier()).toBe(false);
    });

    it('should return false when config files do not set the flag', () => {
      mockReadFileSync({
        [GLOBAL_CONFIG_PATH]: { port: 7247 },
      });
      expect(shouldSkipUpdateNotifier()).toBe(false);
    });

    it('should return true when global config sets skip_update_notifier', () => {
      mockReadFileSync({
        [GLOBAL_CONFIG_PATH]: { skip_update_notifier: true },
      });
      expect(shouldSkipUpdateNotifier()).toBe(true);
    });

    it('should return true when managed config sets skip_update_notifier', () => {
      mockReadFileSync({
        [MANAGED_CONFIG_PATH]: { skip_update_notifier: true },
      });
      expect(shouldSkipUpdateNotifier()).toBe(true);
    });

    it('should let later config files override earlier ones', () => {
      mockReadFileSync({
        [MANAGED_CONFIG_PATH]: { skip_update_notifier: true },
        [GLOBAL_CONFIG_PATH]: { skip_update_notifier: false },
      });
      expect(shouldSkipUpdateNotifier()).toBe(false);
    });

    it('should let project config override global config', () => {
      mockReadFileSync({
        [GLOBAL_CONFIG_PATH]: { skip_update_notifier: false },
        [PROJECT_CONFIG_PATH]: { skip_update_notifier: true },
      });
      expect(shouldSkipUpdateNotifier()).toBe(true);
    });

    it('should let project local config have final say', () => {
      mockReadFileSync({
        [MANAGED_CONFIG_PATH]: { skip_update_notifier: true },
        [GLOBAL_CONFIG_PATH]: { skip_update_notifier: true },
        [PROJECT_LOCAL_CONFIG_PATH]: { skip_update_notifier: false },
      });
      expect(shouldSkipUpdateNotifier()).toBe(false);
    });

    it('should skip malformed config files silently', () => {
      readFileSyncSpy.mockImplementation((filePath) => {
        if (filePath === GLOBAL_CONFIG_PATH) return '{ bad json';
        if (filePath === GLOBAL_LOCAL_CONFIG_PATH) return JSON.stringify({ skip_update_notifier: true });
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });
      expect(shouldSkipUpdateNotifier()).toBe(true);
    });

    it('should coerce truthy values to boolean', () => {
      mockReadFileSync({
        [GLOBAL_CONFIG_PATH]: { skip_update_notifier: 1 },
      });
      expect(shouldSkipUpdateNotifier()).toBe(true);
    });
  });

  describe('getRepoConfig', () => {
    it('should return entry from repos key', () => {
      const config = {
        repos: { 'owner/repo': { path: '~/my-repo' } }
      };
      expect(getRepoConfig(config, 'owner/repo')).toEqual({ path: '~/my-repo' });
    });

    it('should fall back to monorepos key', () => {
      const config = {
        monorepos: { 'owner/repo': { path: '~/legacy-repo' } }
      };
      expect(getRepoConfig(config, 'owner/repo')).toEqual({ path: '~/legacy-repo' });
    });

    it('should prefer repos over monorepos when both exist', () => {
      const config = {
        repos: { 'owner/repo': { path: '~/new-path' } },
        monorepos: { 'owner/repo': { path: '~/old-path' } }
      };
      expect(getRepoConfig(config, 'owner/repo')).toEqual({ path: '~/new-path' });
    });

    it('should prefer repos over monorepos with case-differing raw config keys', () => {
      const config = {
        repos: { 'owner/repo': { pool_size: 0 } },
        monorepos: { 'Owner/Repo': { pool_size: 5 } }
      };
      expect(getRepoConfig(config, 'Owner/Repo')).toEqual({ pool_size: 0 });
    });

    it('should return null for unconfigured repository', () => {
      const config = { repos: { 'other/repo': { path: '~/other' } } };
      expect(getRepoConfig(config, 'owner/repo')).toBe(null);
    });

    it('should return null when neither repos nor monorepos exist', () => {
      const config = {};
      expect(getRepoConfig(config, 'owner/repo')).toBe(null);
    });
  });

  describe('getRepoPath', () => {
    it('should return expanded path from repos key', () => {
      const config = {
        repos: { 'owner/repo': { path: '~/repos/my-repo' } }
      };
      expect(getRepoPath(config, 'owner/repo')).toBe(`${os.homedir()}/repos/my-repo`);
    });

    it('should fall back to monorepos key', () => {
      const config = {
        monorepos: { 'owner/repo': { path: '~/monorepos/my-repo' } }
      };
      expect(getRepoPath(config, 'owner/repo')).toBe(`${os.homedir()}/monorepos/my-repo`);
    });

    it('should return null for unconfigured repository', () => {
      const config = { repos: {} };
      expect(getRepoPath(config, 'owner/repo')).toBe(null);
    });

    it('should return null when config has no path', () => {
      const config = { repos: { 'owner/repo': { checkout_script: './script.sh' } } };
      expect(getRepoPath(config, 'owner/repo')).toBe(null);
    });

  });

  describe('getRepoResetScript', () => {
    it('should return reset script when configured', () => {
      const config = {
        repos: { 'owner/repo': { reset_script: './scripts/reset.sh' } }
      };
      expect(getRepoResetScript(config, 'owner/repo')).toBe('./scripts/reset.sh');
    });

    it('should return null when not configured', () => {
      const config = {
        repos: { 'owner/repo': { path: '~/repo' } }
      };
      expect(getRepoResetScript(config, 'owner/repo')).toBe(null);
    });

    it('should return null for unconfigured repository', () => {
      const config = {};
      expect(getRepoResetScript(config, 'owner/repo')).toBe(null);
    });

    it('should fall back to monorepos key', () => {
      const config = {
        monorepos: { 'owner/repo': { reset_script: './legacy-reset.sh' } }
      };
      expect(getRepoResetScript(config, 'owner/repo')).toBe('./legacy-reset.sh');
    });
  });

  describe('getRepoSkipBulkFetch', () => {
    it('returns true when explicitly enabled', () => {
      const config = {
        repos: { 'owner/repo': { skip_bulk_fetch: true } }
      };
      expect(getRepoSkipBulkFetch(config, 'owner/repo')).toBe(true);
    });

    it('returns false when explicitly disabled', () => {
      const config = {
        repos: { 'owner/repo': { skip_bulk_fetch: false } }
      };
      expect(getRepoSkipBulkFetch(config, 'owner/repo')).toBe(false);
    });

    it('returns false when not configured', () => {
      const config = { repos: { 'owner/repo': { path: '~/repo' } } };
      expect(getRepoSkipBulkFetch(config, 'owner/repo')).toBe(false);
    });

    it('returns false for unconfigured repository', () => {
      expect(getRepoSkipBulkFetch({}, 'owner/repo')).toBe(false);
    });

    it('only treats strict true as enabled (not truthy strings)', () => {
      const config = {
        repos: { 'owner/repo': { skip_bulk_fetch: 'yes' } }
      };
      expect(getRepoSkipBulkFetch(config, 'owner/repo')).toBe(false);
    });
  });

  describe('getRepoPoolSize', () => {
    it('should return configured pool size', () => {
      const config = {
        repos: { 'owner/repo': { pool_size: 3 } }
      };
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(3);
    });

    it('should return 0 when not configured', () => {
      const config = {
        repos: { 'owner/repo': { path: '~/repo' } }
      };
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(0);
    });

    it('should return 0 for unconfigured repository', () => {
      const config = {};
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(0);
    });

    it('should return 0 when pool_size is 0', () => {
      const config = {
        repos: { 'owner/repo': { pool_size: 0 } }
      };
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(0);
    });

    it('should return 0 when pool_size is negative', () => {
      const config = {
        repos: { 'owner/repo': { pool_size: -1 } }
      };
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(0);
    });

    it('should return 0 when pool_size is a string', () => {
      const config = {
        repos: { 'owner/repo': { pool_size: '3' } }
      };
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(0);
    });

    it('should fall back to monorepos key when repos is missing', () => {
      const config = {
        monorepos: { 'owner/repo': { pool_size: 4 } }
      };
      expect(getRepoPoolSize(config, 'owner/repo')).toBe(4);
    });
  });

  describe('getRepoPoolFetchInterval', () => {
    it('should return configured interval', () => {
      const config = {
        repos: { 'owner/repo': { pool_fetch_interval_minutes: 15 } }
      };
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(15);
    });

    it('should return null when not configured', () => {
      const config = {
        repos: { 'owner/repo': { path: '~/repo' } }
      };
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(null);
    });

    it('should return null for unconfigured repository', () => {
      const config = {};
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(null);
    });

    it('should return null when interval is 0', () => {
      const config = {
        repos: { 'owner/repo': { pool_fetch_interval_minutes: 0 } }
      };
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(null);
    });

    it('should return null when interval is negative', () => {
      const config = {
        repos: { 'owner/repo': { pool_fetch_interval_minutes: -5 } }
      };
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(null);
    });

    it('should return null when interval is a string', () => {
      const config = {
        repos: { 'owner/repo': { pool_fetch_interval_minutes: '15' } }
      };
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(null);
    });

    it('should fall back to monorepos key when repos is missing', () => {
      const config = {
        monorepos: { 'owner/repo': { pool_fetch_interval_minutes: 20 } }
      };
      expect(getRepoPoolFetchInterval(config, 'owner/repo')).toBe(20);
    });
  });

  describe('resolveRepoOptions', () => {
    it('should return all defaults when no repo config exists', () => {
      const config = {};
      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe(null);
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toBe(null);
      expect(result.resetScript).toBe(null);
      expect(result.poolSize).toBe(0);
      expect(result.poolFetchIntervalMinutes).toBe(null);
    });

    it('should include new fields when configured', () => {
      const config = {
        repos: {
          'owner/repo': {
            checkout_script: './scripts/checkout.sh',
            reset_script: './scripts/reset.sh',
            pool_size: 5,
            pool_fetch_interval_minutes: 10
          }
        }
      };
      const result = resolveRepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe('./scripts/checkout.sh');
      expect(result.resetScript).toBe('./scripts/reset.sh');
      expect(result.poolSize).toBe(5);
      expect(result.poolFetchIntervalMinutes).toBe(10);
    });

    it('should pass repoSettings through to resolvePoolConfig for DB-aware pool config', () => {
      const config = {
        repos: {
          'owner/repo': {
            checkout_script: './scripts/checkout.sh',
            pool_size: 3,
            pool_fetch_interval_minutes: 15
          }
        }
      };
      const repoSettings = { pool_size: 8, pool_fetch_interval_minutes: 5 };
      const result = resolveRepoOptions(config, 'owner/repo', repoSettings);

      expect(result.checkoutScript).toBe('./scripts/checkout.sh');
      expect(result.poolSize).toBe(8);
      expect(result.poolFetchIntervalMinutes).toBe(5);
    });

    it('should fall back to file config when repoSettings is null', () => {
      const config = {
        repos: {
          'owner/repo': {
            pool_size: 3,
            pool_fetch_interval_minutes: 15
          }
        }
      };
      const result = resolveRepoOptions(config, 'owner/repo', null);

      expect(result.poolSize).toBe(3);
      expect(result.poolFetchIntervalMinutes).toBe(15);
    });

    it('should allow repoSettings to disable fetch interval with 0', () => {
      const config = {
        repos: {
          'owner/repo': {
            pool_size: 3,
            pool_fetch_interval_minutes: 15
          }
        }
      };
      const repoSettings = { pool_size: null, pool_fetch_interval_minutes: 0 };
      const result = resolveRepoOptions(config, 'owner/repo', repoSettings);

      expect(result.poolSize).toBe(3);
      expect(result.poolFetchIntervalMinutes).toBe(null);
    });

  });

  describe('resolvePoolConfig', () => {
    it('should return file config values when no DB settings', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const result = resolvePoolConfig(config, 'owner/repo', null);
      expect(result.poolSize).toBe(3);
      expect(result.poolFetchIntervalMinutes).toBe(15);
    });

    it('should return defaults when neither DB nor file config has values', () => {
      const result = resolvePoolConfig({}, 'owner/repo', null);
      expect(result.poolSize).toBe(0);
      expect(result.poolFetchIntervalMinutes).toBe(null);
    });

    it('should prefer DB settings over file config', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const repoSettings = { pool_size: 5, pool_fetch_interval_minutes: 10 };
      const result = resolvePoolConfig(config, 'owner/repo', repoSettings);
      expect(result.poolSize).toBe(5);
      expect(result.poolFetchIntervalMinutes).toBe(10);
    });

    it('should fall back to file config when DB values are null', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const repoSettings = { pool_size: null, pool_fetch_interval_minutes: null };
      const result = resolvePoolConfig(config, 'owner/repo', repoSettings);
      expect(result.poolSize).toBe(3);
      expect(result.poolFetchIntervalMinutes).toBe(15);
    });

    it('should allow DB to set pool size to 0 (disable)', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const repoSettings = { pool_size: 0, pool_fetch_interval_minutes: null };
      const result = resolvePoolConfig(config, 'owner/repo', repoSettings);
      expect(result.poolSize).toBe(0);
      expect(result.poolFetchIntervalMinutes).toBe(15);
    });

    it('should allow partial DB override (only pool_size)', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const repoSettings = { pool_size: 7, pool_fetch_interval_minutes: null };
      const result = resolvePoolConfig(config, 'owner/repo', repoSettings);
      expect(result.poolSize).toBe(7);
      expect(result.poolFetchIntervalMinutes).toBe(15);
    });

    it('should allow partial DB override (only fetch interval)', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const repoSettings = { pool_size: null, pool_fetch_interval_minutes: 5 };
      const result = resolvePoolConfig(config, 'owner/repo', repoSettings);
      expect(result.poolSize).toBe(3);
      expect(result.poolFetchIntervalMinutes).toBe(5);
    });

    it('should allow DB to set fetch interval to 0 (disable), returning null instead of falling back', () => {
      const config = { repos: { 'owner/repo': { pool_size: 3, pool_fetch_interval_minutes: 15 } } };
      const repoSettings = { pool_size: null, pool_fetch_interval_minutes: 0 };
      const result = resolvePoolConfig(config, 'owner/repo', repoSettings);
      expect(result.poolSize).toBe(3);
      expect(result.poolFetchIntervalMinutes).toBe(null);
    });
  });

  describe('getWorktreeDisplayName', () => {
    it('should return relative path from default worktree base dir', () => {
      const defaultBaseDir = path.join(getConfigDir(), 'worktrees');
      const worktreePath = path.join(defaultBaseDir, 'abc123');
      const result = getWorktreeDisplayName(worktreePath, {}, 'owner/repo');
      expect(result).toBe('abc123');
    });

    it('should return multi-segment relative path for nested worktree names', () => {
      const defaultBaseDir = path.join(getConfigDir(), 'worktrees');
      const worktreePath = path.join(defaultBaseDir, 'abc123', 'src');
      const result = getWorktreeDisplayName(worktreePath, {}, 'owner/repo');
      expect(result).toBe(path.join('abc123', 'src'));
    });

    it('should use configured worktree_directory as base', () => {
      const config = { repos: { 'owner/repo': { worktree_directory: '/custom/worktrees' } } };
      const worktreePath = '/custom/worktrees/pool-1/packages/app';
      const result = getWorktreeDisplayName(worktreePath, config, 'owner/repo');
      expect(result).toBe(path.join('pool-1', 'packages', 'app'));
    });

    it('should fall back to basename when path is outside the base dir', () => {
      const config = {};
      const worktreePath = '/some/completely/different/path/my-checkout';
      const result = getWorktreeDisplayName(worktreePath, config, 'owner/repo');
      expect(result).toBe('my-checkout');
    });

    it('should return null for null input', () => {
      expect(getWorktreeDisplayName(null, {}, 'owner/repo')).toBeNull();
    });

    it('should return null for undefined input', () => {
      expect(getWorktreeDisplayName(undefined, {}, 'owner/repo')).toBeNull();
    });
  });

  describe('getRepoLoadSkills', () => {
    it('returns null when no repos config', () => {
      expect(getRepoLoadSkills({}, 'owner/repo')).toBe(null);
    });

    it('returns null when repo not in config', () => {
      expect(getRepoLoadSkills({ repos: {} }, 'owner/repo')).toBe(null);
    });

    it('returns true when set to true', () => {
      expect(getRepoLoadSkills({ repos: { 'owner/repo': { load_skills: true } } }, 'owner/repo')).toBe(true);
    });

    it('returns false when set to false', () => {
      expect(getRepoLoadSkills({ repos: { 'owner/repo': { load_skills: false } } }, 'owner/repo')).toBe(false);
    });

    it('returns null for non-boolean values', () => {
      expect(getRepoLoadSkills({ repos: { 'owner/repo': { load_skills: 1 } } }, 'owner/repo')).toBe(null);
    });
  });

  describe('resolveLoadSkills', () => {
    it('returns true by default when nothing is set', () => {
      expect(resolveLoadSkills({}, 'owner/repo', null)).toBe(true);
    });

    it('uses DB value (1) over everything', () => {
      const config = { repos: { 'owner/repo': { load_skills: false } } };
      expect(resolveLoadSkills(config, 'owner/repo', { load_skills: 1 }, false)).toBe(true);
    });

    it('uses DB value (0) over everything', () => {
      const config = { repos: { 'owner/repo': { load_skills: true } } };
      expect(resolveLoadSkills(config, 'owner/repo', { load_skills: 0 }, true)).toBe(false);
    });

    it('falls through DB null to repo JSON config', () => {
      const config = { repos: { 'owner/repo': { load_skills: false } } };
      expect(resolveLoadSkills(config, 'owner/repo', { load_skills: null }, true)).toBe(false);
    });

    it('falls through DB null + no repo config to provider config', () => {
      expect(resolveLoadSkills({}, 'owner/repo', null, false)).toBe(false);
    });

    it('converts DB integer 0 to boolean false', () => {
      // Critical: PiProvider checks !== false with strict equality
      const result = resolveLoadSkills({}, 'owner/repo', { load_skills: 0 });
      expect(result).toBe(false);
      expect(result).not.toBe(0); // Must be boolean, not integer
    });

    it('converts DB integer 1 to boolean true', () => {
      const result = resolveLoadSkills({}, 'owner/repo', { load_skills: 1 });
      expect(result).toBe(true);
      expect(result).not.toBe(1); // Must be boolean, not integer
    });
  });

  describe('buildCouncilProviderOverrides', () => {
    it('returns base overrides using tier 1+2 resolution', () => {
      const { providerOverrides } = buildCouncilProviderOverrides({}, 'owner/repo', null);
      expect(providerOverrides).toEqual({ load_skills: true }); // default
    });

    it('returns empty map when no providers configured', () => {
      const { providerOverridesMap } = buildCouncilProviderOverrides({}, 'owner/repo', null);
      expect(providerOverridesMap).toEqual({});
    });

    it('builds per-provider map with tier 3 resolution', () => {
      const config = {
        providers: {
          pi: { load_skills: false },
          claude: { load_skills: true },
        }
      };
      const { providerOverrides, providerOverridesMap } = buildCouncilProviderOverrides(config, 'owner/repo', null);
      // Base (no tier 3) defaults to true
      expect(providerOverrides).toEqual({ load_skills: true });
      // Per-provider includes tier 3
      expect(providerOverridesMap.pi).toEqual({ load_skills: false });
      expect(providerOverridesMap.claude).toEqual({ load_skills: true });
    });

    it('DB repo settings (tier 1) override per-provider tier 3', () => {
      const config = { providers: { pi: { load_skills: false } } };
      const repoSettings = { load_skills: 1 }; // DB says enabled
      const { providerOverrides, providerOverridesMap } = buildCouncilProviderOverrides(config, 'owner/repo', repoSettings);
      expect(providerOverrides).toEqual({ load_skills: true });
      // Tier 1 (DB) takes precedence over tier 3 (provider)
      expect(providerOverridesMap.pi).toEqual({ load_skills: true });
    });
  });

  describe('getSummaryProvider', () => {
    it('returns summaries.provider when set', () => {
      const config = { summaries: { provider: 'gemini' }, default_provider: 'claude' };
      expect(getSummaryProvider(config)).toBe('gemini');
    });

    it('falls back to default_provider when summaries.provider is empty string', () => {
      const config = { summaries: { provider: '' }, default_provider: 'claude' };
      expect(getSummaryProvider(config)).toBe('claude');
    });

    it('falls back to default_provider when summaries.provider is missing', () => {
      const config = { default_provider: 'codex' };
      expect(getSummaryProvider(config)).toBe('codex');
    });

    it('falls back to DEFAULT_CONFIG.default_provider when neither is set', () => {
      const config = {};
      expect(getSummaryProvider(config)).toBe('claude');
    });
  });

  describe('getSummaryModel', () => {
    it('returns summaries.model when set', () => {
      const config = { summaries: { model: 'haiku' }, default_model: 'opus' };
      expect(getSummaryModel(config)).toBe('haiku');
    });

    it('uses fast-tier model from providerClass when summaries.model is empty', () => {
      const config = { summaries: { model: '' }, default_model: 'opus' };
      const FakeProvider = { getModels: () => [
        { id: 'big', tier: 'thorough' },
        { id: 'small', tier: 'fast' }
      ]};
      expect(getSummaryModel(config, FakeProvider)).toBe('small');
    });

    it('falls back to default_model when no providerClass given', () => {
      const config = { summaries: { model: '' }, default_model: 'opus' };
      expect(getSummaryModel(config)).toBe('opus');
    });

    it('falls back to default_model when providerClass has no fast tier', () => {
      const config = { default_model: 'opus' };
      const FakeProvider = { getModels: () => [
        { id: 'big', tier: 'thorough' },
        { id: 'medium', tier: 'balanced' }
      ]};
      expect(getSummaryModel(config, FakeProvider)).toBe('opus');
    });

    it('ignores providerClass when summaries.model is explicitly set', () => {
      const config = { summaries: { model: 'explicit' }, default_model: 'opus' };
      const FakeProvider = { getModels: () => [{ id: 'small', tier: 'fast' }] };
      expect(getSummaryModel(config, FakeProvider)).toBe('explicit');
    });

    it('falls back to DEFAULT_CONFIG.default_model when neither is set', () => {
      const config = {};
      expect(getSummaryModel(config)).toBe('opus');
    });
  });

  describe('getTourProvider', () => {
    it('returns tours.provider when set', () => {
      const config = { tours: { provider: 'codex' }, summaries: { provider: 'gemini' }, default_provider: 'claude' };
      expect(getTourProvider(config)).toBe('codex');
    });

    it('falls back to summaries.provider when tours.provider empty', () => {
      const config = { tours: { provider: '' }, summaries: { provider: 'gemini' }, default_provider: 'claude' };
      expect(getTourProvider(config)).toBe('gemini');
    });

    it('falls back through summaries.provider chain to default_provider', () => {
      const config = { default_provider: 'claude' };
      expect(getTourProvider(config)).toBe('claude');
    });

    it('falls back to DEFAULT_CONFIG.default_provider when nothing is set', () => {
      const config = {};
      expect(getTourProvider(config)).toBe('claude');
    });
  });

  describe('getTourModel', () => {
    it('returns tours.model when set', () => {
      const config = { tours: { model: 'opus' }, summaries: { model: 'haiku' }, default_model: 'sonnet' };
      expect(getTourModel(config)).toBe('opus');
    });

    it('falls back to summaries.model when tours.model empty', () => {
      const config = { tours: { model: '' }, summaries: { model: 'haiku' }, default_model: 'sonnet' };
      expect(getTourModel(config)).toBe('haiku');
    });

    it('falls back to providerClass fast-tier when both empty', () => {
      const config = { tours: { model: '' }, summaries: { model: '' }, default_model: 'opus' };
      const FakeProvider = { getModels: () => [
        { id: 'big', tier: 'thorough' },
        { id: 'small', tier: 'fast' }
      ]};
      expect(getTourModel(config, FakeProvider)).toBe('small');
    });

    it('falls back to default_model when nothing matches', () => {
      const config = { default_model: 'opus' };
      expect(getTourModel(config)).toBe('opus');
    });
  });

  describe('getSummaryEnabled / getSummaryAutoGenerate', () => {
    it('getSummaryEnabled is true only when summaries.enabled === true', () => {
      expect(getSummaryEnabled({ summaries: { enabled: true } })).toBe(true);
      expect(getSummaryEnabled({ summaries: { enabled: false } })).toBe(false);
      expect(getSummaryEnabled({ summaries: {} })).toBe(false);
      expect(getSummaryEnabled({})).toBe(false);
      expect(getSummaryEnabled(null)).toBe(false);
      expect(getSummaryEnabled(undefined)).toBe(false);
    });

    it('getSummaryAutoGenerate defaults to true when unset and respects explicit false', () => {
      expect(getSummaryAutoGenerate({ summaries: { auto_generate: true } })).toBe(true);
      expect(getSummaryAutoGenerate({ summaries: { auto_generate: false } })).toBe(false);
      // Absent key/object → default true (opt-out within the enabled flag).
      expect(getSummaryAutoGenerate({ summaries: { enabled: true } })).toBe(true);
      expect(getSummaryAutoGenerate({ summaries: {} })).toBe(true);
      expect(getSummaryAutoGenerate({})).toBe(true);
      expect(getSummaryAutoGenerate(null)).toBe(true);
      expect(getSummaryAutoGenerate(undefined)).toBe(true);
    });
  });

  describe('getTourEnabled / getTourAutoGenerate', () => {
    it('getTourEnabled is true only when tours.enabled === true', () => {
      expect(getTourEnabled({ tours: { enabled: true } })).toBe(true);
      expect(getTourEnabled({ tours: { enabled: false } })).toBe(false);
      expect(getTourEnabled({ tours: {} })).toBe(false);
      expect(getTourEnabled({})).toBe(false);
      expect(getTourEnabled(null)).toBe(false);
      expect(getTourEnabled(undefined)).toBe(false);
    });

    it('getTourAutoGenerate defaults to true when unset and respects explicit false', () => {
      expect(getTourAutoGenerate({ tours: { auto_generate: true } })).toBe(true);
      expect(getTourAutoGenerate({ tours: { auto_generate: false } })).toBe(false);
      expect(getTourAutoGenerate({ tours: { enabled: true } })).toBe(true);
      expect(getTourAutoGenerate({ tours: {} })).toBe(true);
      expect(getTourAutoGenerate({})).toBe(true);
      expect(getTourAutoGenerate(null)).toBe(true);
      expect(getTourAutoGenerate(undefined)).toBe(true);
    });
  });

  describe('resolveHostBinding', () => {
    let originalEnv;
    let execSyncSpy;
    let warnSpy;

    beforeEach(() => {
      originalEnv = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      _resetTokenCache();
      execSyncSpy = vi.spyOn(childProcess, 'execSync');
      const logger = require('../../src/utils/logger');
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
      _resetTokenCache();
      execSyncSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('returns null apiHost and graphql defaults for the no-repo fallback', () => {
      const binding = resolveHostBinding(null, { github_token: 'top' });
      expect(binding.apiHost).toBeNull();
      expect(binding.token).toBe('top');
      expect(binding.source).toBe('config:github_token');
      expect(binding.features.pending_review_check).toBe('graphql');
      expect(binding.features.stack_walker).toBe('graphql');
      expect(binding.features.review_lifecycle).toBe('graphql');
      expect(binding.features.pending_review_comments).toBe('graphql');
    });

    it('returns null apiHost and graphql defaults for a github.com repo with no api_host', () => {
      const config = {
        github_token: 'top',
        repos: { 'owner/repo': { path: '/tmp/x' } }
      };
      const binding = resolveHostBinding('owner/repo', config);
      expect(binding.apiHost).toBeNull();
      expect(binding.features.pending_review_check).toBe('graphql');
    });

    it('returns rest defaults for every area when api_host is set', () => {
      const config = {
        repos: {
          'owner/repo': {
            api_host: 'https://althost.example/api/v3',
            token: 'alt-token',
            // Explicit override since the alt-host default for this area is "host"
            features: { pending_review_comments: 'host' }
          }
        }
      };
      const binding = resolveHostBinding('owner/repo', config);
      expect(binding.apiHost).toBe('https://althost.example/api/v3');
      expect(binding.features.pending_review_check).toBe('rest');
      expect(binding.features.stack_walker).toBe('rest');
      expect(binding.features.review_lifecycle).toBe('rest');
      expect(binding.features.pending_review_comments).toBe('host');
    });

    it('honours explicit features overrides on top of defaults', () => {
      const config = {
        repos: {
          'owner/repo': {
            api_host: 'https://althost.example/api/v3',
            token: 'alt-token',
            features: { pending_review_comments: 'host' }
          }
        }
      };
      const binding = resolveHostBinding('owner/repo', config);
      expect(binding.features.pending_review_comments).toBe('host');
      // Other areas keep alt-host default
      expect(binding.features.review_lifecycle).toBe('rest');
    });

    describe('token resolution for github.com repos', () => {
      it('uses GITHUB_TOKEN env var when api_host is unset', () => {
        process.env.GITHUB_TOKEN = 'env-token';
        const config = {
          github_token: 'top',
          repos: { 'owner/repo': { token: 'repo-literal' } }
        };
        const binding = resolveHostBinding('owner/repo', config);
        expect(binding.token).toBe('env-token');
        expect(binding.source).toBe('env:GITHUB_TOKEN');
      });

      it('falls back through repo:token -> repo:token_command -> config:github_token -> config:github_token_command', () => {
        // repo:token wins over top-level keys
        let binding = resolveHostBinding('owner/repo', {
          github_token: 'top',
          repos: { 'owner/repo': { token: 'repo-literal' } }
        });
        expect(binding.token).toBe('repo-literal');
        expect(binding.source).toBe('repo:token');

        // repo:token_command wins over top-level when no repo:token
        execSyncSpy.mockReturnValueOnce('repo-cmd-token\n');
        binding = resolveHostBinding('owner/repo', {
          github_token: 'top',
          repos: { 'owner/repo': { token_command: 'echo repo-cmd' } }
        });
        expect(binding.token).toBe('repo-cmd-token');
        expect(binding.source).toBe('repo:token_command');

        // top-level github_token used when no repo-level keys
        binding = resolveHostBinding('owner/repo', {
          github_token: 'top',
          repos: { 'owner/repo': {} }
        });
        expect(binding.token).toBe('top');
        expect(binding.source).toBe('config:github_token');

        // top-level github_token_command used as last resort
        _resetTokenCache();
        execSyncSpy.mockReturnValueOnce('top-cmd-token\n');
        binding = resolveHostBinding('owner/repo', {
          github_token_command: 'echo top-cmd',
          repos: { 'owner/repo': {} }
        });
        expect(binding.token).toBe('top-cmd-token');
        expect(binding.source).toBe('config:github_token_command');
      });
    });

    describe('token resolution for alt-host repos', () => {
      it('does NOT use GITHUB_TOKEN env var when api_host is set', () => {
        process.env.GITHUB_TOKEN = 'github-com-env-token';
        const config = {
          github_token: 'top',
          repos: {
            'owner/repo': {
              api_host: 'https://althost.example/api/v3',
              token: 'alt-literal'
            }
          }
        };
        const binding = resolveHostBinding('owner/repo', config);
        expect(binding.token).toBe('alt-literal');
        expect(binding.source).toBe('repo:token');
      });

      it('does NOT fall through to top-level github_token for alt-hosts (Fix #4)', () => {
        process.env.GITHUB_TOKEN = 'github-com-env-token';
        // Only top-level token configured — alt-host must NOT fall
        // through. The top-level token is a github.com credential and
        // would auth-fail against the alt-host endpoint.
        const binding = resolveHostBinding('owner/repo', {
          github_token: 'top-shared',
          repos: { 'owner/repo': { api_host: 'https://althost.example/api/v3' } }
        });
        expect(binding.token).toBe('');
        expect(binding.source).toBe('none');
      });

      it('prefers repo:token_command over top-level for alt-host', () => {
        execSyncSpy.mockReturnValueOnce('alt-cmd-token\n');
        const binding = resolveHostBinding('owner/repo', {
          github_token: 'top',
          repos: {
            'owner/repo': {
              api_host: 'https://althost.example/api/v3',
              token_command: 'op read op://alt/token'
            }
          }
        });
        expect(binding.token).toBe('alt-cmd-token');
        expect(binding.source).toBe('repo:token_command');
      });
    });

    describe('token_command caching', () => {
      it('caches per (repository, command) and does not collapse across repos', () => {
        execSyncSpy.mockReturnValueOnce('token-a\n').mockReturnValueOnce('token-b\n');
        const config = {
          repos: {
            'owner/a': { token_command: 'echo a' },
            'owner/b': { token_command: 'echo b' }
          }
        };

        // First call for each repo runs execSync
        expect(resolveHostBinding('owner/a', config).token).toBe('token-a');
        expect(resolveHostBinding('owner/b', config).token).toBe('token-b');
        expect(execSyncSpy).toHaveBeenCalledTimes(2);

        // Repeat calls are cached
        expect(resolveHostBinding('owner/a', config).token).toBe('token-a');
        expect(resolveHostBinding('owner/b', config).token).toBe('token-b');
        expect(execSyncSpy).toHaveBeenCalledTimes(2);
      });

      it('treats the same command across different repos as separate cache entries', () => {
        execSyncSpy.mockReturnValueOnce('alpha\n').mockReturnValueOnce('beta\n');
        const config = {
          repos: {
            'owner/a': { token_command: 'gh auth token' },
            'owner/b': { token_command: 'gh auth token' }
          }
        };
        expect(resolveHostBinding('owner/a', config).token).toBe('alpha');
        expect(resolveHostBinding('owner/b', config).token).toBe('beta');
        // Two execSync invocations even though the command string is identical
        expect(execSyncSpy).toHaveBeenCalledTimes(2);
      });

      it('does not cache empty or failing token_command results', () => {
        execSyncSpy.mockReturnValueOnce('\n').mockReturnValueOnce('eventually\n');
        const config = {
          repos: { 'owner/a': { token_command: 'echo nothing' } }
        };
        expect(resolveHostBinding('owner/a', config).token).toBe('');
        expect(resolveHostBinding('owner/a', config).token).toBe('eventually');
        expect(execSyncSpy).toHaveBeenCalledTimes(2);
      });

      it('runs top-level github_token_command once total across multiple repos', () => {
        // Top-level github_token_command is a SINGLE shared provider; it
        // must NOT be re-invoked per repo. Previously the cache was keyed
        // on (repository, command) for both repo-level and top-level
        // commands, so each repo's fallback re-ran the command.
        execSyncSpy.mockReturnValueOnce('shared-top-token\n');
        const config = {
          github_token_command: 'gh auth token',
          repos: {
            'owner/a': {},
            'owner/b': {},
            'owner/c': {}
          }
        };
        expect(resolveHostBinding('owner/a', config).token).toBe('shared-top-token');
        expect(resolveHostBinding('owner/b', config).token).toBe('shared-top-token');
        expect(resolveHostBinding('owner/c', config).token).toBe('shared-top-token');
        // One invocation total — not one per repo.
        expect(execSyncSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('returns empty token and source "none" when nothing resolves', () => {
      const binding = resolveHostBinding('owner/repo', { repos: { 'owner/repo': {} } });
      expect(binding.token).toBe('');
      expect(binding.source).toBe('none');
    });

    describe('alt-host token isolation (Fix #4)', () => {
      it('does NOT use top-level github_token for an alt-host repo', () => {
        const config = {
          github_token: 'top-level-ghp',
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: { stack_walker: 'rest' }
            }
          }
        };
        const binding = resolveHostBinding('owner/alt', config);
        expect(binding.token).toBe('');
        expect(binding.source).toBe('none');
        expect(binding.apiHost).toBe('https://althost.example/api/v3');
      });

      it('still uses top-level github_token for github.com repos', () => {
        const config = {
          github_token: 'top-level-ghp',
          repos: { 'owner/normal': {} }
        };
        const binding = resolveHostBinding('owner/normal', config);
        expect(binding.token).toBe('top-level-ghp');
        expect(binding.source).toBe('config:github_token');
        expect(binding.apiHost).toBe(null);
      });

      it('does NOT invoke top-level github_token_command for an alt-host repo', () => {
        execSyncSpy.mockReturnValueOnce('cmd-token\n');
        const config = {
          github_token_command: 'gh auth token',
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3'
            }
          }
        };
        const binding = resolveHostBinding('owner/alt', config);
        expect(binding.token).toBe('');
        expect(binding.source).toBe('none');
        expect(execSyncSpy).not.toHaveBeenCalled();
      });

      it('does not warn when an alt-host repo has its own token', () => {
        const config = {
          github_token: 'top-level-ghp',
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              token: 'alt-host-token'
            }
          }
        };
        const binding = resolveHostBinding('owner/alt', config);
        expect(binding.token).toBe('alt-host-token');
        const matched = warnSpy.mock.calls.find(c =>
          /likely the wrong token/.test(String(c[0]))
        );
        expect(matched).toBeFalsy();
      });
    });
  });

  describe('validateRepoConfig', () => {
    it('does not throw on the happy path (no repos, or repos without alt-host config)', () => {
      expect(() => validateRepoConfig({})).not.toThrow();
      expect(() => validateRepoConfig({ repos: {} })).not.toThrow();
      expect(() => validateRepoConfig({
        repos: { 'owner/repo': { path: '/tmp/x' } }
      })).not.toThrow();
      expect(() => validateRepoConfig({
        repos: {
          'owner/alt': {
            api_host: 'https://althost.example/api/v3',
            features: { pending_review_comments: 'host', stack_walker: 'rest' }
          }
        }
      })).not.toThrow();
    });

    it('throws when api_host is set and a feature requests graphql', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/alt': {
            api_host: 'https://althost.example/api/v3',
            features: { stack_walker: 'graphql' }
          }
        }
      })).toThrow(/repos\["owner\/alt"\] sets api_host but features\.stack_walker = "graphql"/);
    });

    it('throws when api_host is unset and a feature requests host', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            features: { pending_review_comments: 'host' }
          }
        }
      })).toThrow(/repos\["owner\/repo"\]\.features\.pending_review_comments = "host" requires api_host to be set/);
    });

    it('throws on an invalid features value', () => {
      expect(() => validateRepoConfig({
        repos: { 'owner/repo': { features: { stack_walker: 'magic' } } }
      })).toThrow(/repos\["owner\/repo"\]\.features\.stack_walker = "magic" is not one of/);
    });

    it('throws on an invalid url_pattern regex', () => {
      expect(() => validateRepoConfig({
        repos: { 'owner/repo': { url_pattern: '([unterminated' } }
      })).toThrow(/repos\["owner\/repo"\]\.url_pattern is not a valid regular expression:/);
    });

    it('accepts a valid url_pattern regex', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      })).not.toThrow();
    });

    it('throws on an invalid git_remote_pattern regex', () => {
      expect(() => validateRepoConfig({
        repos: { 'owner/repo': { git_remote_pattern: '([unterminated' } }
      })).toThrow(/repos\["owner\/repo"\]\.git_remote_pattern is not a valid regular expression:/);
    });

    it('throws when git_remote_pattern is not a string', () => {
      expect(() => validateRepoConfig({
        repos: { 'owner/repo': { git_remote_pattern: 123 } }
      })).toThrow(/repos\["owner\/repo"\]\.git_remote_pattern must be a string regex/);
    });

    it('accepts a valid git_remote_pattern regex', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            git_remote_pattern: '^git@althost\\.example:scm/owner/repo(\\.git)?$'
          }
        }
      })).not.toThrow();
    });

    it('throws when links.external is missing label', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            links: { external: { url_template: 'https://althost.example/x' } }
          }
        }
      })).toThrow(/links\.external\.label/);
    });

    it('throws when links.external is missing url_template', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            links: { external: { label: 'Open' } }
          }
        }
      })).toThrow(/links\.external\.url_template/);
    });

    it('throws when links.external.url_template is not https://', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            links: { external: { label: 'Open', url_template: 'http://althost.example/{owner}/{repo}' } }
          }
        }
      })).toThrow(/url_template must start with "https:\/\/"/);
    });

    it('accepts a valid links.external block', () => {
      expect(() => validateRepoConfig({
        repos: {
          'owner/repo': {
            links: { external: { label: 'Open', url_template: 'https://althost.example/{owner}/{repo}/pull/{number}' } }
          }
        }
      })).not.toThrow();
    });

    describe('pending_review_comments_endpoint override (Phase 5)', () => {
      it('accepts a valid endpoint override with all four placeholders', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).not.toThrow();
      });

      it('throws when a placeholder is missing (e.g. {review_id})', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/comments'
              }
            }
          }
        })).toThrow(/missing required placeholder\(s\): \{review_id\}/);
      });

      it('throws when {pull_number} is missing (placeholder is {pull_number}, not {number})', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  '/repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/missing required placeholder\(s\): \{pull_number\}/);
      });

      it('throws when {owner} and {repo} are both missing', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  '/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/missing required placeholder\(s\): \{owner\}, \{repo\}/);
      });

      it('rejects absolute http:// URLs', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  'http://althost.example/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/must be a relative path/);
      });

      it('rejects absolute https:// URLs', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  'https://althost.example/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/must be a relative path/);
      });

      it('rejects protocol-relative URLs', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  '//althost.example/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/must be a relative path/);
      });

      it('rejects empty-string endpoint override', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint: ''
              }
            }
          }
        })).toThrow(/must be a non-empty string/);
      });

      it('throws when endpoint override is set but pending_review_comments is not "host"', () => {
        // Note: this also implicitly checks the area = "graphql" path
        // would fail first on a github.com repo, so use a repo with no
        // api_host and the area still set to a non-host value indirectly
        // via the default ("graphql" for github.com). Use the explicit
        // case here.
        expect(() => validateRepoConfig({
          repos: {
            'owner/repo': {
              features: {
                pending_review_comments_endpoint:
                  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/only valid when pending_review_comments = "host"/);
      });
    });

    describe('feature key allowlist', () => {
      it('throws on an unknown feature key (typo) and lists valid keys', () => {
        expect(() => validateRepoConfig({
          repos: { 'owner/repo': { features: { pendin_review_check: 'rest' } } }
        })).toThrow(/repos\["owner\/repo"\]\.features\.pendin_review_check is not a recognised feature area/);

        // The error should enumerate valid feature areas so the user can
        // self-correct without grepping the source.
        try {
          validateRepoConfig({
            repos: { 'owner/repo': { features: { pendin_review_check: 'rest' } } }
          });
        } catch (err) {
          expect(err.message).toContain('pending_review_check');
          expect(err.message).toContain('stack_walker');
          expect(err.message).toContain('review_lifecycle');
          expect(err.message).toContain('pending_review_comments');
        }
      });

      it('throws on an unknown _endpoint sub-key (typo)', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_commentes_endpoint:
                  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).toThrow(/pending_review_commentes_endpoint is not a recognised endpoint override/);
      });

      it('accepts the recognised pending_review_comments_endpoint sub-key', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_comments: 'host',
                pending_review_comments_endpoint:
                  '/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments'
              }
            }
          }
        })).not.toThrow();
      });
    });

    describe('implementation matrix', () => {
      // The matrix below mirrors IMPLEMENTATION_MATRIX in src/config.js,
      // which is built from the IMPLEMENTED_MODES exports in each
      // src/github/operations/*.js module. If a dispatcher gains a new
      // mode, both the matrix and these tests should update together.

      it('rejects review_lifecycle="host" on an alt-host (Phase 5 not implemented)', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: { review_lifecycle: 'host' }
            }
          }
        })).toThrow(/features\.review_lifecycle = "host" is not implemented[\s\S]*Implemented modes for review_lifecycle: graphql, rest/);
      });

      it('rejects pending_review_comments="rest" on github.com (REST not supported for drafts)', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/repo': {
              features: { pending_review_comments: 'rest' }
            }
          }
        })).toThrow(/features\.pending_review_comments = "rest" is not implemented[\s\S]*Implemented modes for pending_review_comments: graphql, host/);
      });

      it('rejects stack_walker="host" on an alt-host (Phase 5 not implemented)', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: { stack_walker: 'host' }
            }
          }
        })).toThrow(/features\.stack_walker = "host" is not implemented[\s\S]*Implemented modes for stack_walker: graphql, rest/);
      });

      it('rejects pending_review_check="host" on an alt-host (Phase 5 not implemented)', () => {
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: { pending_review_check: 'host' }
            }
          }
        })).toThrow(/features\.pending_review_check = "host" is not implemented[\s\S]*Implemented modes for pending_review_check: graphql, rest/);
      });

      it('accepts every currently-implemented (area, mode) combination', () => {
        // github.com — graphql is the default-implemented mode for all
        // four areas.
        expect(() => validateRepoConfig({
          repos: {
            'owner/repo': {
              features: {
                pending_review_check: 'graphql',
                stack_walker: 'graphql',
                review_lifecycle: 'graphql',
                pending_review_comments: 'graphql'
              }
            }
          }
        })).not.toThrow();

        // github.com — rest is implemented for the three non-comment areas.
        expect(() => validateRepoConfig({
          repos: {
            'owner/repo': {
              features: {
                pending_review_check: 'rest',
                stack_walker: 'rest',
                review_lifecycle: 'rest'
              }
            }
          }
        })).not.toThrow();

        // Alt-host — rest for everything, host for pending_review_comments.
        expect(() => validateRepoConfig({
          repos: {
            'owner/alt': {
              api_host: 'https://althost.example/api/v3',
              features: {
                pending_review_check: 'rest',
                stack_walker: 'rest',
                review_lifecycle: 'rest',
                pending_review_comments: 'host'
              }
            }
          }
        })).not.toThrow();
      });
    });
  });

  describe('matchRepoByUrl', () => {
    it('returns null when no repos have a url_pattern', () => {
      const config = { repos: { 'owner/repo': { path: '/tmp/x' } } };
      expect(matchRepoByUrl('https://althost.example/owner/repo/pull/42', config)).toBeNull();
    });

    it('returns null when the URL does not match any pattern', () => {
      const config = {
        repos: {
          'owner/repo': {
            url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      };
      expect(matchRepoByUrl('https://github.com/octocat/Hello-World/pull/1', config)).toBeNull();
    });

    it('extracts owner/repo/number from named capture groups', () => {
      const config = {
        repos: {
          'owner/repo': {
            url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      };
      const match = matchRepoByUrl('https://althost.example/acme/widgets/pull/123', config);
      expect(match).not.toBeNull();
      expect(match.owner).toBe('acme');
      expect(match.repo).toBe('widgets');
      expect(match.number).toBe(123);
      expect(typeof match.number).toBe('number');
      expect(match.repository).toBe('acme/widgets');
      expect(match.repoConfig).toBe(config.repos['owner/repo']);
    });

    it('falls back to the repo config key when regex has no named groups', () => {
      const config = {
        repos: {
          'owner/repo': {
            url_pattern: '^https://althost\\.example/owner/repo/pull/[0-9]+'
          }
        }
      };
      const match = matchRepoByUrl('https://althost.example/owner/repo/pull/7', config);
      expect(match).not.toBeNull();
      expect(match.repository).toBe('owner/repo');
      expect(match.owner).toBeUndefined();
      expect(match.repo).toBeUndefined();
      expect(match.number).toBeUndefined();
    });

    it('returns null for empty/missing URL inputs', () => {
      const config = {
        repos: {
          'owner/repo': {
            url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      };
      expect(matchRepoByUrl('', config)).toBeNull();
      expect(matchRepoByUrl(null, config)).toBeNull();
      expect(matchRepoByUrl(undefined, config)).toBeNull();
    });

    it('iterates multiple repos and matches the first hit', () => {
      const config = {
        repos: {
          'first/repo': {
            url_pattern: '^https://althost\\.example/first/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          },
          'second/repo': {
            url_pattern: '^https://althost\\.example/second/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      };
      const match = matchRepoByUrl('https://althost.example/second/team/proj/pull/5', config);
      expect(match.owner).toBe('team');
      expect(match.repo).toBe('proj');
      expect(match.number).toBe(5);
    });
  });

  describe('getGitHubToken with repository arg', () => {
    let originalEnv;
    let execSyncSpy;
    let warnSpy;

    beforeEach(() => {
      originalEnv = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      _resetTokenCache();
      execSyncSpy = vi.spyOn(childProcess, 'execSync');
      const logger = require('../../src/utils/logger');
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.GITHUB_TOKEN = originalEnv;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
      _resetTokenCache();
      execSyncSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('delegates to resolveHostBinding for repo-aware lookups', () => {
      const config = {
        github_token: 'top',
        repos: { 'owner/repo': { token: 'repo-literal' } }
      };
      expect(getGitHubToken(config, 'owner/repo')).toBe('repo-literal');
    });

    it('omitting repository preserves the no-repo fallback behaviour', () => {
      const config = { github_token: 'top' };
      expect(getGitHubToken(config)).toBe('top');
    });

    it('alt-host repo skips GITHUB_TOKEN env var', () => {
      process.env.GITHUB_TOKEN = 'github-com-env';
      const config = {
        github_token: 'top-shared',
        repos: {
          'owner/alt': { api_host: 'https://althost.example/api/v3' }
        }
      };
      // For alt-host repo: env var skipped AND top-level credentials
      // are no longer consulted (Fix #4). The lookup returns '' so the
      // caller can surface a clear missing-token error.
      expect(getGitHubToken(config, 'owner/alt')).toBe('');
      // No-repo call: env var still wins
      expect(getGitHubToken(config)).toBe('github-com-env');
    });
  });

  // -------------------------------------------------------------------
  // Fix #3: alt-host pending_review_comments defaults to "host"
  // -------------------------------------------------------------------
  describe('_resolveFeatures alt-host defaults (Fix #3)', () => {
    it('defaults pending_review_comments to "host" on an alt-host repo', () => {
      const config = {
        repos: {
          'owner/alt': {
            api_host: 'https://althost.example/api/v3',
            token: 'tok'
          }
        }
      };
      const binding = resolveHostBinding('owner/alt', config);
      expect(binding.features.pending_review_comments).toBe('host');
      // Other areas still default to rest.
      expect(binding.features.pending_review_check).toBe('rest');
      expect(binding.features.stack_walker).toBe('rest');
      expect(binding.features.review_lifecycle).toBe('rest');
    });

    it('does NOT change the github.com default — pending_review_comments stays "graphql"', () => {
      const binding = resolveHostBinding('owner/normal', {
        github_token: 'top',
        repos: { 'owner/normal': {} }
      });
      expect(binding.features.pending_review_comments).toBe('graphql');
    });

    it('explicit features.pending_review_comments override still wins on alt-host', () => {
      const binding = resolveHostBinding('owner/alt', {
        repos: {
          'owner/alt': {
            api_host: 'https://althost.example/api/v3',
            token: 'tok',
            // user explicitly opts out (would be rejected by
            // validateRepoConfig today, but the resolver itself must
            // still honour the override so future modes work).
            features: { pending_review_comments: 'rest' }
          }
        }
      });
      expect(binding.features.pending_review_comments).toBe('rest');
    });

    it('validateRepoConfig validates resolved defaults for areas the user did not override (Fix #3)', () => {
      // Plain alt-host repo with no overrides. With Fix #3, the default
      // pending_review_comments value resolves to "host" which IS
      // implemented — must not throw.
      expect(() => validateRepoConfig({
        repos: {
          'owner/alt': {
            api_host: 'https://althost.example/api/v3'
          }
        }
      })).not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // Fix #8: resolveBindingRepositoryFromPR
  // -------------------------------------------------------------------
  describe('resolveBindingRepositoryFromPR (Fix #8)', () => {
    it('returns lowercased owner/repo when no config entry exists', () => {
      expect(resolveBindingRepositoryFromPR('Acme', 'Widgets', { repos: {} }))
        .toBe('acme/widgets');
      expect(resolveBindingRepositoryFromPR('acme', 'widgets', {}))
        .toBe('acme/widgets');
    });

    it('returns the exact config key when it matches case-insensitively', () => {
      const config = {
        repos: {
          'Acme/Widgets': { path: '/tmp/x' }
        }
      };
      // Direct (lowercased) key hit
      expect(resolveBindingRepositoryFromPR('acme', 'widgets', { repos: { 'acme/widgets': {} } }))
        .toBe('acme/widgets');
      // Case-insensitive scan
      expect(resolveBindingRepositoryFromPR('ACME', 'WIDGETS', config))
        .toBe('Acme/Widgets');
    });

    it('finds a monorepo-shaped entry whose url_pattern captures the owner/repo', () => {
      const config = {
        repos: {
          'company/monorepo': {
            api_host: 'https://althost.example/api/v3',
            url_pattern: '^https://althost\\.example/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      };
      expect(resolveBindingRepositoryFromPR('team', 'sub', config))
        .toBe('company/monorepo');
    });

    it('falls back to owner/repo when no entry can be matched', () => {
      const config = {
        repos: {
          'company/monorepo': {
            api_host: 'https://althost.example/api/v3',
            url_pattern: '^https://althost\\.example/specific/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>[0-9]+)'
          }
        }
      };
      // The pattern requires `/specific/` in the path; team/sub
      // won't fit the candidates we probe.
      expect(resolveBindingRepositoryFromPR('team', 'sub', config))
        .toBe('team/sub');
    });

    it('returns owner/repo fallback when owner or repo is missing', () => {
      expect(resolveBindingRepositoryFromPR('', '', {})).toBe('/');
      expect(resolveBindingRepositoryFromPR(null, 'repo', {})).toBe('/repo');
      expect(resolveBindingRepositoryFromPR('owner', undefined, {})).toBe('owner/');
    });
  });
});
