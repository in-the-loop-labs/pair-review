// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';

// Test the parseArgs and detectPRFromGitHubEnvironment functions exported from main.js
const { parseArgs, detectPRFromGitHubEnvironment } = require('../../src/main');
const logger = require('../../src/utils/logger');

describe('main.js parseArgs', () => {
  describe('flag parsing', () => {
    it('should parse --ai flag', () => {
      const result = parseArgs(['123', '--ai']);
      expect(result.flags.ai).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --ai-draft flag', () => {
      const result = parseArgs(['123', '--ai-draft']);
      expect(result.flags.aiDraft).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --model flag with value', () => {
      const result = parseArgs(['123', '--model', 'opus']);
      expect(result.flags.model).toBe('opus');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should throw error when --model flag has no value', () => {
      expect(() => parseArgs(['123', '--model'])).toThrow('--model flag requires a model name');
    });

    it('should throw error when --model flag is followed by another flag', () => {
      expect(() => parseArgs(['123', '--model', '--ai'])).toThrow('--model flag requires a model name');
    });

    it('should parse --local flag without path', () => {
      const result = parseArgs(['--local']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.localPath).toBeUndefined();
    });

    it('should parse --local flag with path', () => {
      const result = parseArgs(['--local', '/path/to/repo']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.localPath).toBe('/path/to/repo');
    });

    it('should parse -l short flag without path', () => {
      const result = parseArgs(['-l']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.localPath).toBeUndefined();
    });

    it('should parse -l short flag with path', () => {
      const result = parseArgs(['-l', '/path/to/repo']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.localPath).toBe('/path/to/repo');
    });

    it('should not consume next argument as localPath if it starts with -', () => {
      const result = parseArgs(['--local', '--ai']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.localPath).toBeUndefined();
      expect(result.flags.ai).toBe(true);
    });

    it('should not consume next argument as localPath if it starts with short flag', () => {
      const result = parseArgs(['-l', '-h']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.localPath).toBeUndefined();
    });

    it('should parse PR number as prArgs', () => {
      const result = parseArgs(['123']);
      expect(result.prArgs).toEqual(['123']);
      expect(result.flags).toEqual({});
    });

    it('should parse PR URL as prArgs', () => {
      const result = parseArgs(['https://github.com/owner/repo/pull/123']);
      expect(result.prArgs).toEqual(['https://github.com/owner/repo/pull/123']);
    });

    it('should handle multiple flags', () => {
      const result = parseArgs(['123', '--ai', '--model', 'haiku']);
      expect(result.flags.ai).toBe(true);
      expect(result.flags.model).toBe('haiku');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should throw error on unknown flags', () => {
      expect(() => parseArgs(['123', '--unknown-flag'])).toThrow('Unknown flag: --unknown-flag');
    });

    it('should throw error on multiple unknown flags', () => {
      expect(() => parseArgs(['123', '--foo', '--bar'])).toThrow('Unknown flags: --foo, --bar');
    });

    it('should throw error on unknown short flags', () => {
      expect(() => parseArgs(['123', '-x'])).toThrow('Unknown flag: -x');
    });

    it('should include help suggestion in unknown flag error', () => {
      expect(() => parseArgs(['123', '--hepl'])).toThrow("Run 'pair-review --help' for usage information");
    });

    it('should handle flags in any order', () => {
      const result = parseArgs(['--ai', '123', '--model', 'opus']);
      expect(result.flags.ai).toBe(true);
      expect(result.flags.model).toBe('opus');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should skip --configure flag', () => {
      const result = parseArgs(['--configure']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});
    });

    it('should skip -h and --help flags', () => {
      const result = parseArgs(['-h']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});

      const result2 = parseArgs(['--help']);
      expect(result2.prArgs).toEqual([]);
      expect(result2.flags).toEqual({});
    });

    it('should skip -v and --version flags', () => {
      const result = parseArgs(['-v']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});

      const result2 = parseArgs(['--version']);
      expect(result2.prArgs).toEqual([]);
      expect(result2.flags).toEqual({});
    });

    it('should parse --debug flag', () => {
      const result = parseArgs(['123', '--debug']);
      expect(result.flags.debug).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse -d short flag for debug', () => {
      const result = parseArgs(['123', '-d']);
      expect(result.flags.debug).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should enable logger debug mode when --debug flag is present', () => {
      // Reset logger debug mode before test
      logger.setDebugEnabled(false);

      parseArgs(['123', '--debug']);
      expect(logger.isDebugEnabled()).toBe(true);

      // Clean up
      logger.setDebugEnabled(false);
    });

    it('should enable logger debug mode when -d flag is present', () => {
      // Reset logger debug mode before test
      logger.setDebugEnabled(false);

      parseArgs(['123', '-d']);
      expect(logger.isDebugEnabled()).toBe(true);

      // Clean up
      logger.setDebugEnabled(false);
    });

    it('should parse --debug-stream flag', () => {
      const result = parseArgs(['123', '--debug-stream']);
      expect(result.flags.debugStream).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should enable logger stream debug mode when --debug-stream flag is present', () => {
      // Reset logger stream debug mode before test
      logger.setStreamDebugEnabled(false);

      parseArgs(['123', '--debug-stream']);
      expect(logger.isStreamDebugEnabled()).toBe(true);

      // Clean up
      logger.setStreamDebugEnabled(false);
    });

    it('should allow both --debug and --debug-stream flags together', () => {
      // Reset both modes before test
      logger.setDebugEnabled(false);
      logger.setStreamDebugEnabled(false);

      const result = parseArgs(['123', '--debug', '--debug-stream']);
      expect(result.flags.debug).toBe(true);
      expect(result.flags.debugStream).toBe(true);
      expect(logger.isDebugEnabled()).toBe(true);
      expect(logger.isStreamDebugEnabled()).toBe(true);

      // Clean up
      logger.setDebugEnabled(false);
      logger.setStreamDebugEnabled(false);
    });

    // Tests for GitHub Action review mode flags
    it('should parse --ai-review flag', () => {
      const result = parseArgs(['123', '--ai-review']);
      expect(result.flags.aiReview).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --use-checkout flag', () => {
      const result = parseArgs(['123', '--use-checkout']);
      expect(result.flags.useCheckout).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse all action mode flags together', () => {
      const result = parseArgs(['123', '--ai-review', '--use-checkout', '--model', 'haiku']);
      expect(result.flags.aiReview).toBe(true);
      expect(result.flags.useCheckout).toBe(true);
      expect(result.flags.model).toBe('haiku');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --yolo flag', () => {
      const result = parseArgs(['123', '--yolo']);
      expect(result.flags.yolo).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --yolo with other flags', () => {
      const result = parseArgs(['123', '--yolo', '--ai', '--model', 'opus']);
      expect(result.flags.yolo).toBe(true);
      expect(result.flags.ai).toBe(true);
      expect(result.flags.model).toBe('opus');
      expect(result.prArgs).toEqual(['123']);
    });
  });
});

describe('CLI help and version', () => {
  // These are integration tests that actually invoke the CLI
  // They test that the binary responds correctly to -h and -v flags

  it('should show help text when --help is passed', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('pair-review');
    expect(output).toContain('USAGE:');
    expect(output).toContain('OPTIONS:');
    expect(output).toContain('EXAMPLES:');
    expect(output).toContain('--help');
    expect(output).toContain('--version');
    expect(output).toContain('--local');
    expect(output).toContain('--model');
    expect(output).toContain('--ai');
    expect(output).toContain('--ai-draft');
    expect(output).toContain('--debug');
    expect(output).toContain('--yolo');
  });

  it('should show help text when -h is passed', () => {
    const output = execSync('node bin/pair-review.js -h', { encoding: 'utf-8' });

    expect(output).toContain('USAGE:');
    expect(output).toContain('OPTIONS:');
  });

  it('should show version when --version is passed', () => {
    const output = execSync('node bin/pair-review.js --version', { encoding: 'utf-8' });

    expect(output).toMatch(/pair-review v\d+\.\d+\.\d+/);
  });

  it('should show version when -v is passed', () => {
    const output = execSync('node bin/pair-review.js -v', { encoding: 'utf-8' });

    expect(output).toMatch(/pair-review v\d+\.\d+\.\d+/);
  });

  it('help output should contain environment variables section', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('ENVIRONMENT VARIABLES:');
    expect(output).toContain('GITHUB_TOKEN');
    expect(output).toContain('PAIR_REVIEW_CLAUDE_CMD');
    expect(output).toContain('PAIR_REVIEW_GEMINI_CMD');
    expect(output).toContain('PAIR_REVIEW_CODEX_CMD');
    expect(output).toContain('PAIR_REVIEW_MODEL');
  });

  it('help output should contain configuration section', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('CONFIGURATION:');
    expect(output).toContain('~/.pair-review/config.json');
    expect(output).toContain('github_token');
  });

  it('help output should mention -l short flag for local', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('-l, --local');
  });

  it('help output should mention -d short flag for debug', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('-d, --debug');
  });

  it('help output should mention --debug-stream flag', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('--debug-stream');
    expect(output).toContain('streaming events');
  });

  it('help output should mention Claude Code as default provider', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('Claude Code is the default provider');
  });

  it('--help should exit with code 0', () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--help']);
    expect(result.status).toBe(0);
  });

  it('-h should exit with code 0', () => {
    const result = spawnSync('node', ['bin/pair-review.js', '-h']);
    expect(result.status).toBe(0);
  });

  it('--version should exit with code 0', () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--version']);
    expect(result.status).toBe(0);
  });

  it('-v should exit with code 0', () => {
    const result = spawnSync('node', ['bin/pair-review.js', '-v']);
    expect(result.status).toBe(0);
  });
});

describe('CLI --configure', () => {
  it('should show comprehensive configuration help', () => {
    const output = execSync('node bin/pair-review.js --configure', { encoding: 'utf-8' });

    expect(output).toContain('pair-review Configuration');
    expect(output).toContain('CONFIG FILE:');
    expect(output).toContain('~/.pair-review/config.json');
    expect(output).toContain('GITHUB TOKEN:');
    expect(output).toContain('github.com/settings/tokens/new');
    expect(output).toContain('repo');
    expect(output).toContain('public_repo');
    expect(output).toContain('ENVIRONMENT VARIABLES:');
    expect(output).toContain('GITHUB_TOKEN');
    expect(output).toContain('AI PROVIDERS:');
    expect(output).toContain('Claude (default)');
  });

  it('should mention GITHUB_TOKEN takes precedence over config file', () => {
    const output = execSync('node bin/pair-review.js --configure', { encoding: 'utf-8' });

    expect(output).toContain('GITHUB_TOKEN environment variable');
    expect(output).toContain('takes precedence');
  });

  it('--configure should exit with code 0', () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--configure']);
    expect(result.status).toBe(0);
  });
});

describe('detectPRFromGitHubEnvironment', () => {
  const originalEnv = {};

  beforeEach(() => {
    // Save original values for all GitHub env vars we'll manipulate
    originalEnv.GITHUB_ACTIONS = process.env.GITHUB_ACTIONS;
    originalEnv.GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
    originalEnv.GITHUB_REF = process.env.GITHUB_REF;
    originalEnv.GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH;

    // Clear them all so tests start from a clean state
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF;
    delete process.env.GITHUB_EVENT_PATH;
  });

  afterEach(() => {
    // Restore original values
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should return null when GITHUB_ACTIONS is not true', () => {
    expect(detectPRFromGitHubEnvironment()).toBeNull();
  });

  it('should return null when GITHUB_ACTIONS is true but GITHUB_REPOSITORY is not set', () => {
    process.env.GITHUB_ACTIONS = 'true';
    expect(detectPRFromGitHubEnvironment()).toBeNull();
  });

  it('should return null when GITHUB_REPOSITORY has no slash', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = 'invalid-repo';
    expect(detectPRFromGitHubEnvironment()).toBeNull();
  });

  it('should extract PR number from GITHUB_REF', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF = 'refs/pull/123/merge';

    const result = detectPRFromGitHubEnvironment();
    expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 123 });
  });

  it('should fall back to GITHUB_EVENT_PATH when GITHUB_REF has no PR pattern', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF = 'refs/heads/main';

    // Create a temporary event file
    const path = require('path');
    const fs = require('fs');
    const os = require('os');
    const eventFile = path.join(os.tmpdir(), `pr-event-${Date.now()}.json`);
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 456 } }));
    process.env.GITHUB_EVENT_PATH = eventFile;

    try {
      const result = detectPRFromGitHubEnvironment();
      expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 456 });
    } finally {
      fs.unlinkSync(eventFile);
    }
  });

  it('should return null when no PR info is available', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF = 'refs/heads/main';
    // No GITHUB_EVENT_PATH set

    expect(detectPRFromGitHubEnvironment()).toBeNull();
  });
});
