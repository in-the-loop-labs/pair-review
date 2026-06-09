// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

    it('should parse --council flag with value', () => {
      const result = parseArgs(['123', '--council', 'my-council']);
      expect(result.flags.council).toBe('my-council');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should throw error when --council flag has no value', () => {
      expect(() => parseArgs(['123', '--council'])).toThrow('--council flag requires a council handle');
    });

    it('should throw error when --council flag is followed by another flag', () => {
      expect(() => parseArgs(['123', '--council', '--ai'])).toThrow('--council flag requires a council handle');
    });

    it('should parse --list-councils flag', () => {
      const result = parseArgs(['--list-councils']);
      expect(result.flags.listCouncils).toBe(true);
      expect(result.prArgs).toEqual([]);
    });

    it('should parse --ai-draft together with --council', () => {
      const result = parseArgs(['123', '--ai-draft', '--council', 'x']);
      expect(result.flags.aiDraft).toBe(true);
      expect(result.flags.council).toBe('x');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --provider flag with value', () => {
      const result = parseArgs(['123', '--provider', 'codex']);
      expect(result.flags.provider).toBe('codex');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should throw error when --provider flag has no value', () => {
      expect(() => parseArgs(['123', '--provider'])).toThrow('--provider flag requires a provider name');
    });

    it('should throw error when --provider flag is followed by another flag', () => {
      expect(() => parseArgs(['123', '--provider', '--ai'])).toThrow('--provider flag requires a provider name');
    });

    it('should parse --provider together with --model', () => {
      const result = parseArgs(['123', '--ai-draft', '--provider', 'codex', '--model', 'gpt-5.5-xhigh']);
      expect(result.flags.aiDraft).toBe(true);
      expect(result.flags.provider).toBe('codex');
      expect(result.flags.model).toBe('gpt-5.5-xhigh');
      expect(result.prArgs).toEqual(['123']);
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

    it('should reject --local flag with URL path', () => {
      expect(() => parseArgs(['--local', 'https://github.com/owner/repo/pull/123']))
        .toThrow('filesystem path');
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

    it('should skip --register flag', () => {
      const result = parseArgs(['--register']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});
    });

    it('should skip --unregister flag', () => {
      const result = parseArgs(['--unregister']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});
    });

    it('should skip --command flag with its value', () => {
      const result = parseArgs(['--register', '--command', 'node bin/pr.js']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});
    });

    it('should skip --command flag without value', () => {
      const result = parseArgs(['--register', '--command']);
      expect(result.prArgs).toEqual([]);
      expect(result.flags).toEqual({});
    });

    // --- Headless CLI analysis flags (--headless, --json, --instructions[-file]) ---

    it('should parse --headless flag', () => {
      const result = parseArgs(['123', '--headless']);
      expect(result.flags.headless).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --json flag', () => {
      const result = parseArgs(['123', '--headless', '--json']);
      expect(result.flags.headless).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.prArgs).toEqual(['123']);
    });

    it('should parse --headless and --json together with --local', () => {
      const result = parseArgs(['--local', '--headless', '--json']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.headless).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.flags.localPath).toBeUndefined();
      expect(result.prArgs).toEqual([]);
    });

    it('should parse --headless and --json together with a PR arg', () => {
      const result = parseArgs(['456', '--headless', '--json']);
      expect(result.flags.headless).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.prArgs).toEqual(['456']);
    });

    it('should parse --instructions flag and consume its text value', () => {
      const result = parseArgs(['123', '--instructions', 'be terse']);
      expect(result.flags.instructions).toBe('be terse');
      // The text value must NOT be left in prArgs.
      expect(result.prArgs).toEqual(['123']);
    });

    it('should accept an --instructions value that starts with "-" (free text)', () => {
      const result = parseArgs(['--local', '--headless', '--instructions', '-be terse']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.headless).toBe(true);
      // Unlike --model/--council, a value beginning with '-' is allowed for free text.
      expect(result.flags.instructions).toBe('-be terse');
      expect(result.prArgs).toEqual([]);
    });

    it('should throw error when --instructions has no following token', () => {
      expect(() => parseArgs(['123', '--instructions'])).toThrow('--instructions flag requires a text value');
    });

    it('should parse --instructions-file flag with a path', () => {
      const result = parseArgs(['123', '--instructions-file', './x.md']);
      expect(result.flags.instructionsFile).toBe('./x.md');
      expect(result.prArgs).toEqual(['123']);
    });

    it('should throw error when --instructions-file has no value', () => {
      expect(() => parseArgs(['123', '--instructions-file'])).toThrow('--instructions-file flag requires a file path');
    });

    it('should throw error when --instructions-file is followed by another flag', () => {
      expect(() => parseArgs(['123', '--instructions-file', '--headless'])).toThrow('--instructions-file flag requires a file path');
    });

    it('should parse a full headless council invocation', () => {
      const result = parseArgs(['--local', '--headless', '--json', '--council', 'security', '--instructions', 'focus on auth']);
      expect(result.flags.local).toBe(true);
      expect(result.flags.headless).toBe(true);
      expect(result.flags.json).toBe(true);
      expect(result.flags.council).toBe('security');
      expect(result.flags.instructions).toBe('focus on auth');
      expect(result.prArgs).toEqual([]);
    });

    // Regression: a representative pre-existing invocation must still parse exactly.
    it('should still parse a representative pre-headless invocation', () => {
      const result = parseArgs(['123', '--ai', '--model', 'opus']);
      expect(result.flags.ai).toBe(true);
      expect(result.flags.model).toBe('opus');
      expect(result.flags.headless).toBeUndefined();
      expect(result.flags.json).toBeUndefined();
      expect(result.prArgs).toEqual(['123']);
    });

    // NOTE: Cross-flag validations live in main() AFTER parseArgs, not in
    // parseArgs itself: "--json requires --headless", mutual exclusion of
    // --instructions/--instructions-file, and "--headless requires a PR arg or
    // --local". These are exercised by the guarded CLI-spawn smoke tests in the
    // "headless CLI smoke" describe block below (main() is not cleanly unit-
    // testable without spawning, since it performs DB init, config load, and a
    // process.exit path).
  });
});

describe('CLI help and version', () => {
  // These are integration tests that actually invoke the CLI
  // They test that the binary responds correctly to -h and -v flags

  it('should show help text when --help is passed', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

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
    const output = execSync(`${process.execPath} bin/pair-review.js -h`, { encoding: 'utf-8' });

    expect(output).toContain('USAGE:');
    expect(output).toContain('OPTIONS:');
  });

  it('should show version when --version is passed', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --version`, { encoding: 'utf-8' });

    expect(output).toMatch(/pair-review v\d+\.\d+\.\d+/);
  });

  it('should show version when -v is passed', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js -v`, { encoding: 'utf-8' });

    expect(output).toMatch(/pair-review v\d+\.\d+\.\d+/);
  });

  it('help output should contain environment variables section', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

    expect(output).toContain('ENVIRONMENT VARIABLES:');
    expect(output).toContain('GITHUB_TOKEN');
    expect(output).toContain('PAIR_REVIEW_CLAUDE_CMD');
    expect(output).toContain('PAIR_REVIEW_ANTIGRAVITY_CMD');
    expect(output).toContain('PAIR_REVIEW_CODEX_CMD');
    expect(output).toContain('PAIR_REVIEW_MODEL');
  });

  it('help output should contain configuration section', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

    expect(output).toContain('CONFIGURATION:');
    expect(output).toContain('~/.pair-review/config.json');
    expect(output).toContain('github_token');
  });

  it('help output should mention -l short flag for local', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

    expect(output).toContain('-l, --local');
  });

  it('help output should mention -d short flag for debug', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

    expect(output).toContain('-d, --debug');
  });

  it('help output should mention --debug-stream flag', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

    expect(output).toContain('--debug-stream');
    expect(output).toContain('streaming events');
  });

  it('help output should mention --register flag', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });
    expect(output).toContain('--register');
    expect(output).toContain('pair-review://');
  });

  it('help output should mention Claude Code as default provider', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --help`, { encoding: 'utf-8' });

    expect(output).toContain('Claude Code is the default provider');
  });

  it('--help should exit with code 0', () => {
    const result = spawnSync(process.execPath, ['bin/pair-review.js', '--help']);
    expect(result.status).toBe(0);
  });

  it('-h should exit with code 0', () => {
    const result = spawnSync(process.execPath, ['bin/pair-review.js', '-h']);
    expect(result.status).toBe(0);
  });

  it('--version should exit with code 0', () => {
    const result = spawnSync(process.execPath, ['bin/pair-review.js', '--version']);
    expect(result.status).toBe(0);
  });

  it('-v should exit with code 0', () => {
    const result = spawnSync(process.execPath, ['bin/pair-review.js', '-v']);
    expect(result.status).toBe(0);
  });
});

describe('CLI child process spawning', () => {
  it('should use the same Node.js binary as the parent process, not node from PATH', () => {
    // Create a temp directory with a fake "node" that always fails
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-test-'));
    const fakeNode = path.join(tmpDir, 'node');
    fs.writeFileSync(fakeNode, '#!/bin/sh\necho "WRONG_NODE" >&2\nexit 99\n');
    fs.chmodSync(fakeNode, 0o755);

    try {
      // Spawn bin/pair-review.js --version using the real node (process.execPath),
      // but with the fake node first in PATH. If the bin script correctly uses
      // process.execPath, the child process will use the real node and succeed.
      // If it spawns 'node' from PATH, it'll hit the fake one and fail.
      const result = spawnSync(process.execPath, ['bin/pair-review.js', '--version'], {
        env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
        encoding: 'utf-8'
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/pair-review v\d+\.\d+\.\d+/);
      expect(result.stderr).not.toContain('WRONG_NODE');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('CLI --configure', () => {
  it('should show comprehensive configuration help', () => {
    const output = execSync(`${process.execPath} bin/pair-review.js --configure`, { encoding: 'utf-8' });

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
    const output = execSync(`${process.execPath} bin/pair-review.js --configure`, { encoding: 'utf-8' });

    expect(output).toContain('GITHUB_TOKEN environment variable');
    expect(output).toContain('takes precedence');
  });

  it('--configure should exit with code 0', () => {
    const result = spawnSync(process.execPath, ['bin/pair-review.js', '--configure']);
    expect(result.status).toBe(0);
  });
});

describe('headless CLI smoke (main()-level validations)', () => {
  // These exercise the cross-flag validations that live in main() AFTER
  // parseArgs and so are not reachable from parseArgs unit tests. Each guard
  // throws BEFORE any database init, GitHub call, or analyzer spawn, so the
  // child exits immediately — these are cheap and reliable (unlike a full
  // `--local --headless --json` run, which would spawn a real provider CLI and
  // is known-flaky locally; see coverage-gap note below).
  //
  // PAIR_REVIEW_NO_OPEN=1 guarantees no browser tab is opened (project rule).
  //
  // Each spawn also gets an ISOLATED temp HOME: main() runs loadConfig()
  // BEFORE these flag validations (src/main.js), so spawning with the real
  // HOME would create ~/.pair-review in the real home dir on a clean machine,
  // and a malformed real config would exit with a different message —
  // environment-dependent failures. Mirrors headless-json-error.test.js.
  let testHomeDir;
  let childEnv;

  beforeAll(() => {
    testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-main-headless-'));
    // Pre-create config so these are not first-runs (no welcome-box noise).
    const configDir = path.join(testHomeDir, '.pair-review');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ github_token: '', port: 7247, theme: 'light' }, null, 2)
    );
    childEnv = { ...process.env, PAIR_REVIEW_NO_OPEN: '1', HOME: testHomeDir, GITHUB_TOKEN: '' };
  });

  afterAll(() => {
    if (testHomeDir) {
      fs.rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  const run = (args) =>
    spawnSync(process.execPath, ['bin/pair-review.js', ...args], { env: childEnv, encoding: 'utf-8' });

  it('--json without --headless exits non-zero with a clear message', () => {
    const result = run(['--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--json requires --headless/);
  });

  it('--headless without a PR arg or --local exits non-zero with a clear message', () => {
    const result = run(['--headless']);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--headless flag requires a pull request number\/URL or --local/);
  });

  it('--instructions together with --instructions-file is rejected as mutually exclusive', () => {
    const result = run(['--local', '--headless', '--instructions', 'a', '--instructions-file', './x.md']);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/mutually exclusive/);
  });

  it('--instructions without an analysis-running mode exits non-zero with a clear message', () => {
    // A bare PR arg never auto-analyzes interactively, so --instructions would
    // be silently dropped — reject it instead of advertising a no-op. This guard
    // throws in the same early validation block as the others (before any DB /
    // server / network work), so it stays cheap and reliable.
    const result = run(['123', '--instructions', 'focus on auth']);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/require a mode that runs analysis/);
  });

  // COVERAGE GAP (intentional): the full happy-path smoke — `--local --headless
  // --json` in a temp git repo emitting a single clean JSON document on stdout
  // with no leading log lines — is NOT spawned here. It would invoke a real
  // provider CLI (claude/gemini/etc.) for the analysis step, which is slow,
  // environment-dependent, and flaky in CI/local (see project memory:
  // first-run.test.js local hang). The stdout-discipline + JSON-shape behavior
  // is instead covered deterministically at the DB level by
  // tests/unit/headless-json.test.js (buildHeadlessJson) and
  // tests/integration/headless-analysis.test.js (runHeadlessAnalysis end to
  // end), and stderr redirection is covered by mcp-stdio.test.js.
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
