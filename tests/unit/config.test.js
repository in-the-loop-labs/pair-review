// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { deepMerge, getGitHubToken, expandPath, resolveDbName, warnIfDevModeWithoutDbName, loadConfig, shouldSkipUpdateNotifier, _resetTokenCache, getRepoConfig, getRepoPath, getRepoCheckoutScript, getRepoWorktreeDirectory, getRepoWorktreeNameTemplate, getRepoCheckoutTimeout, resolveRepoOptions, getRepoResetScript, getRepoPoolSize, getRepoPoolFetchInterval, resolvePoolConfig, getWorktreeDisplayName, getConfigDir } = require('../../src/config');

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
});
