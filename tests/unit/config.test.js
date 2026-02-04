// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const os = require('os');
const { getGitHubToken, expandPath, getMonorepoPath } = require('../../src/config');

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
});
