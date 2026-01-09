import { describe, it, expect, beforeEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';

// Test the parseArgs function which is exported from main.js
const { parseArgs } = require('../../src/main');

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

  it('help output should mention Claude as default provider', () => {
    const output = execSync('node bin/pair-review.js --help', { encoding: 'utf-8' });

    expect(output).toContain('Claude is the default provider');
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
    expect(output).toContain('AI PROVIDERS:');
    expect(output).toContain('Claude (default)');
  });

  it('--configure should exit with code 0', () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--configure']);
    expect(result.status).toBe(0);
  });
});
