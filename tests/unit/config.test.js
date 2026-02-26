// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getGitHubToken, expandPath, getMonorepoPath, getMonorepoCheckoutScript, getMonorepoWorktreeDirectory, getMonorepoWorktreeNameTemplate, getMonorepoCheckoutTimeout, resolveMonorepoOptions, resolveDbName, warnIfDevModeWithoutDbName, loadConfig } = require('../../src/config');

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

    it('should handle ~ alone (not followed by /)', () => {
      const result = expandPath('~');
      expect(result).toBe('~');
    });

    it('should handle paths with ~ in the middle', () => {
      const result = expandPath('/path/with~/tilde');
      expect(result).toBe('/path/with~/tilde');
    });
  });

  describe('getMonorepoPath', () => {
    it('should return expanded path for configured repository', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/monorepos/my-repo' }
        }
      };

      const result = getMonorepoPath(config, 'owner/repo');
      expect(result).toBe(`${os.homedir()}/monorepos/my-repo`);
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { path: '~/other' }
        }
      };

      const result = getMonorepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no monorepos', () => {
      const config = {};

      const result = getMonorepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when monorepos is undefined', () => {
      const config = { github_token: 'token' };

      const result = getMonorepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when monorepo config has no path', () => {
      const config = {
        monorepos: {
          'owner/repo': { description: 'no path here' }
        }
      };

      const result = getMonorepoPath(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should handle absolute paths without expansion', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '/absolute/path/to/repo' }
        }
      };

      const result = getMonorepoPath(config, 'owner/repo');
      expect(result).toBe('/absolute/path/to/repo');
    });
  });

  describe('getMonorepoCheckoutScript', () => {
    it('should return checkout script for configured repository', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_script: './scripts/pr-checkout.sh' }
        }
      };

      const result = getMonorepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe('./scripts/pr-checkout.sh');
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { checkout_script: './scripts/other.sh' }
        }
      };

      const result = getMonorepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when monorepo config has no checkout_script', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getMonorepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no monorepos', () => {
      const config = {};

      const result = getMonorepoCheckoutScript(config, 'owner/repo');
      expect(result).toBe(null);
    });
  });

  describe('getMonorepoWorktreeDirectory', () => {
    it('should return expanded path for configured repository', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_directory: '~/custom/worktrees' }
        }
      };

      const result = getMonorepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(`${os.homedir()}/custom/worktrees`);
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { worktree_directory: '~/other/worktrees' }
        }
      };

      const result = getMonorepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when monorepo config has no worktree_directory', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getMonorepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no monorepos', () => {
      const config = {};

      const result = getMonorepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should handle absolute paths without expansion', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_directory: '/absolute/worktrees' }
        }
      };

      const result = getMonorepoWorktreeDirectory(config, 'owner/repo');
      expect(result).toBe('/absolute/worktrees');
    });
  });

  describe('getMonorepoWorktreeNameTemplate', () => {
    it('should return template for configured repository', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_name_template: '{id}/src' }
        }
      };

      const result = getMonorepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe('{id}/src');
    });

    it('should return null for unconfigured repository', () => {
      const config = {
        monorepos: {
          'other/repo': { worktree_name_template: '{id}' }
        }
      };

      const result = getMonorepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when monorepo config has no worktree_name_template', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getMonorepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return null when config has no monorepos', () => {
      const config = {};

      const result = getMonorepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe(null);
    });

    it('should return complex templates with multiple variables', () => {
      const config = {
        monorepos: {
          'owner/repo': { worktree_name_template: 'pr-{pr_number}/{owner}-{repo}/{id}' }
        }
      };

      const result = getMonorepoWorktreeNameTemplate(config, 'owner/repo');
      expect(result).toBe('pr-{pr_number}/{owner}-{repo}/{id}');
    });
  });

  describe('getMonorepoCheckoutTimeout', () => {
    it('should return configured value converted to milliseconds', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_timeout_seconds: 120 }
        }
      };

      const result = getMonorepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(120000);
    });

    it('should return default 300000 when not configured', () => {
      const config = {
        monorepos: {
          'owner/repo': { path: '~/some/path' }
        }
      };

      const result = getMonorepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when monorepos section does not have the repo', () => {
      const config = {
        monorepos: {
          'other/repo': { checkout_timeout_seconds: 60 }
        }
      };

      const result = getMonorepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when config has no monorepos', () => {
      const config = {};

      const result = getMonorepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when checkout_timeout_seconds is 0 (falsy)', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_timeout_seconds: 0 }
        }
      };

      const result = getMonorepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });

    it('should return default when checkout_timeout_seconds is negative', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_timeout_seconds: -10 }
        }
      };

      // Negative values are now correctly rejected by the > 0 guard
      const result = getMonorepoCheckoutTimeout(config, 'owner/repo');
      expect(result).toBe(300000);
    });
  });

  describe('resolveMonorepoOptions', () => {
    it('should return null for both when no monorepo config exists', () => {
      const config = {};

      const result = resolveMonorepoOptions(config, 'owner/repo');

      expect(result.checkoutScript).toBe(null);
      expect(result.checkoutTimeout).toBe(300000);
      expect(result.worktreeConfig).toBe(null);
    });

    it('should return checkoutScript when only checkout_script is configured', () => {
      const config = {
        monorepos: {
          'owner/repo': { checkout_script: './scripts/checkout.sh' }
        }
      };

      const result = resolveMonorepoOptions(config, 'owner/repo');

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

      const result = resolveMonorepoOptions(config, 'owner/repo');

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

      const result = resolveMonorepoOptions(config, 'owner/repo');

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

      const result = resolveMonorepoOptions(config, 'owner/repo');

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

      const result = resolveMonorepoOptions(config, 'owner/repo');

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

      const result = resolveMonorepoOptions(config, 'owner/repo');

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

  describe('loadConfig', () => {
    const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.pair-review', 'config.json');
    const LOCAL_CONFIG_PATH = path.join(process.cwd(), '.pair-review', 'config.json');

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

    function mockReadFile(globalJson, localJson) {
      readFileSpy.mockImplementation(async (filePath) => {
        if (filePath === GLOBAL_CONFIG_PATH) {
          if (globalJson === null) {
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            throw err;
          }
          return JSON.stringify(globalJson);
        }
        if (filePath === LOCAL_CONFIG_PATH) {
          if (localJson === null) {
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            throw err;
          }
          return JSON.stringify(localJson);
        }
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      });
    }

    it('should deep-merge global config partial chat object with defaults', async () => {
      mockReadFile(
        { port: 7247, chat: { enable_shortcuts: false } },
        null  // no local config
      );

      const { config } = await loadConfig();

      expect(config.chat).toEqual({ enable_shortcuts: false });
    });

    it('should three-way merge defaults, global, and local for nested objects', async () => {
      mockReadFile(
        { port: 7247, chat: { enable_shortcuts: false } },
        { chat: { some_future_key: true } }
      );

      const { config } = await loadConfig();

      expect(config.chat).toEqual({ enable_shortcuts: false, some_future_key: true });
    });

    it('should let local config override global for the same nested key', async () => {
      mockReadFile(
        { chat: { enable_shortcuts: false } },
        { chat: { enable_shortcuts: true } }
      );

      const { config } = await loadConfig();

      expect(config.chat.enable_shortcuts).toBe(true);
    });

    it('should preserve object defaults when config only has scalar keys', async () => {
      mockReadFile(
        { port: 8080, theme: 'dark' },
        null  // no local config
      );

      const { config } = await loadConfig();

      expect(config.chat).toEqual({ enable_shortcuts: true });
    });
  });
});
