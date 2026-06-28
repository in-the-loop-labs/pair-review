// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration test: in --headless --json mode, a failure must emit the
 * machine-readable failure envelope on STDOUT (not prose on stderr) and exit
 * non-zero, so an agent parses one stream and branches on `ok`.
 *
 * We trigger an early, deterministic flag-validation error (--instructions and
 * --instructions-file are mutually exclusive). It throws right after parseArgs,
 * BEFORE any DB/server/git/network work, which keeps this spawn test fast and
 * avoids the local single-port dev-server hang that deeper headless paths risk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.join(__dirname, '../..');

function runCli(args, homeDir) {
  // Use process.execPath (not the literal 'node') so the child runs under the
  // SAME Node major as the test runner — better-sqlite3 is a native module and
  // only loads under the Node ABI its binary was built for.
  return spawnSync(process.execPath, ['bin/pair-review.js', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      GITHUB_TOKEN: '',
      PAIR_REVIEW_NO_OPEN: '1'
    },
    timeout: 15000
  });
}

describe('headless --json failure envelope', () => {
  let testHomeDir;
  let originalHome;

  beforeEach(async () => {
    testHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-headless-json-err-'));
    originalHome = process.env.HOME;
    // Pre-create config so this is not a first-run (no welcome path to interfere).
    const configDir = path.join(testHomeDir, '.pair-review');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ github_token: '', port: 7247, theme: 'light' }, null, 2)
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (testHomeDir) {
      await fs.rm(testHomeDir, { recursive: true, force: true });
    }
  });

  it('emits { ok: false, error } as JSON on stdout and exits non-zero', () => {
    const result = runCli(
      ['--headless', '--json', '--instructions', 'a', '--instructions-file', '/no/such/file'],
      testHomeDir
    );

    expect(result.status).toBe(1);

    const stdout = (result.stdout?.toString() || '').trim();
    // stdout must be ONLY the JSON document — JSON.parse throws otherwise.
    const doc = JSON.parse(stdout);
    expect(doc.ok).toBe(false);
    expect(doc.mode).toBe('pr');
    expect(typeof doc.error.message).toBe('string');
    expect(doc.error.message.length).toBeGreaterThan(0);
    expect(doc.error.message).toContain('mutually exclusive');
  });

  it('derives mode: "local" from --local in the failure envelope', () => {
    const result = runCli(
      ['--local', '--headless', '--json', '--instructions', 'a', '--instructions-file', '/no/such/file'],
      testHomeDir
    );

    expect(result.status).toBe(1);
    const doc = JSON.parse((result.stdout?.toString() || '').trim());
    expect(doc.ok).toBe(false);
    expect(doc.mode).toBe('local');
  });

  it('without --json, the same failure stays prose-on-stderr with empty stdout', () => {
    const result = runCli(
      ['--headless', '--instructions', 'a', '--instructions-file', '/no/such/file'],
      testHomeDir
    );

    expect(result.status).toBe(1);
    const stdout = (result.stdout?.toString() || '').trim();
    const stderr = result.stderr?.toString() || '';
    expect(stdout).toBe('');
    expect(stderr).toContain('Error:');
    expect(stderr).toContain('mutually exclusive');
  });
});
