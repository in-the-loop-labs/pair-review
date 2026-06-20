// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the council-related CLI flags (--list-councils and
 * --council), exercising the real CLI as a spawned child process.
 *
 * Unlike the direct-call unit tests (resolve-council, print-council-list),
 * these run `bin/pair-review.js` end-to-end so they cover argv parsing, config
 * + DB resolution from a real config dir, process exit codes, and the stderr
 * formatting for bad handles — the class of behavior a direct function call
 * cannot reach.
 *
 * The council is seeded by a separate child `node` process so it uses the real
 * production `initializeDatabase` + `CouncilRepository` against the test's
 * temp HOME (CONFIG_DIR is fixed at module load from os.homedir(), so the
 * parent process can't write to the child's config dir directly).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.join(__dirname, '../..');
const DB_MODULE = path.join(REPO_ROOT, 'src/database.js');

const SAMPLE_CONFIG = {
  levels: {
    '1': { enabled: true, voices: [{ provider: 'claude', model: 'sonnet', tier: 'balanced' }] },
    '2': { enabled: false, voices: [] },
    '3': { enabled: false, voices: [] }
  }
};

/**
 * Run the CLI as a child process with the test's temp HOME.
 * @param {string[]} args - CLI arguments
 * @param {string} testHomeDir - temp HOME for config/DB isolation
 * @param {Object<string,string>} [extraEnv] - extra env vars merged last (e.g.
 *   to simulate a GitHub Actions environment). An empty-string value clears the
 *   inherited variable, which matters when the test runner itself executes in
 *   CI and would otherwise leak real GITHUB_* values into the child.
 */
function runCli(args, testHomeDir, extraEnv = {}) {
  // Use process.execPath (not the literal 'node') so the child runs under the
  // SAME Node major as the test runner — better-sqlite3 is a native module and
  // only loads under the Node ABI its binary was built for.
  return spawnSync(process.execPath, ['bin/pair-review.js', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHomeDir,
      GITHUB_TOKEN: '',
      PAIR_REVIEW_NO_OPEN: '1',
      ...extraEnv
    },
    timeout: 20000
  });
}

/**
 * Seed a council into the test HOME's database via a child node process using
 * production code (no schema duplication). Council fields are passed via env
 * vars to avoid inline-script quoting hazards.
 */
function seedCouncil(testHomeDir, { id, name, type }) {
  const seedScript = `
    const { initializeDatabase, CouncilRepository } = require(process.env.SEED_DB_MODULE);
    (async () => {
      const db = await initializeDatabase('database.db');
      await new CouncilRepository(db).create({
        id: process.env.SEED_COUNCIL_ID,
        name: process.env.SEED_COUNCIL_NAME,
        type: process.env.SEED_COUNCIL_TYPE,
        config: JSON.parse(process.env.SEED_COUNCIL_CONFIG)
      });
      db.close();
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', seedScript], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHomeDir,
      SEED_DB_MODULE: DB_MODULE,
      SEED_COUNCIL_ID: id,
      SEED_COUNCIL_NAME: name,
      SEED_COUNCIL_TYPE: type,
      SEED_COUNCIL_CONFIG: JSON.stringify(SAMPLE_CONFIG),
      PAIR_REVIEW_NO_OPEN: '1'
    },
    timeout: 20000
  });
  if (result.status !== 0) {
    throw new Error(`Council seed failed: ${result.stderr?.toString() || result.stdout?.toString()}`);
  }
}

describe('CLI council flags (integration)', () => {
  let testHomeDir;

  beforeEach(async () => {
    testHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-council-'));
    // Pre-create the config dir + config.json so the DB file can be created and
    // the first-run welcome banner is suppressed.
    const configDir = path.join(testHomeDir, '.pair-review');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ github_token: '', port: 7247, theme: 'light' }, null, 2)
    );
  });

  afterEach(async () => {
    if (testHomeDir) {
      await fs.rm(testHomeDir, { recursive: true, force: true });
    }
  });

  it('--list-councils exits 0 and prints the seeded council handle, name, and type', () => {
    const councilId = uuidv4();
    seedCouncil(testHomeDir, { id: councilId, name: 'Integration Council', type: 'council' });

    const result = runCli(['--list-councils'], testHomeDir);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    expect(stdout).toContain(councilId.slice(0, 8)); // short handle
    expect(stdout).toContain('Integration Council');
    expect(stdout).toContain('council'); // type column
  });

  it('--list-councils reports an empty list when no councils are seeded', () => {
    const result = runCli(['--list-councils'], testHomeDir);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    expect(stdout).toContain('No councils found');
  });

  it('--ai-draft with a bad --council handle exits non-zero with a clear error', () => {
    seedCouncil(testHomeDir, { id: uuidv4(), name: 'Integration Council', type: 'council' });

    const result = runCli(['1', '--ai-draft', '--council', 'definitely-not-a-real-handle'], testHomeDir);
    const stderr = result.stderr?.toString() || '';

    expect(result.status).not.toBe(0);
    expect(stderr).toMatch(/No council matches/);
  });

  it('--council without a PR or --local exits non-zero with a usage error', () => {
    seedCouncil(testHomeDir, { id: uuidv4(), name: 'Integration Council', type: 'council' });

    const result = runCli(['--council', 'Integration Council'], testHomeDir);
    const stderr = result.stderr?.toString() || '';

    expect(result.status).not.toBe(0);
    expect(stderr).toMatch(/--council flag requires a pull request/);
  });

  it('--ai-review --council in GitHub Actions bypasses the early --council guard', () => {
    // Regression: the early --council guard must NOT reject the documented
    // GitHub Actions `--ai-review --council` flow, where the PR is auto-detected
    // from the environment. We deliberately leave the PR undetectable (no
    // GITHUB_REF / GITHUB_EVENT_PATH) so the run still exits non-zero — but via
    // the later --ai-review "no PR" check, NOT the early --council guard. This
    // proves the guard was bypassed without triggering a real headless review.
    seedCouncil(testHomeDir, { id: uuidv4(), name: 'Integration Council', type: 'council' });

    const result = runCli(['--ai-review', '--council', 'Integration Council'], testHomeDir, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'owner/repo',
      // Clear inherited CI values so PR auto-detection deterministically fails.
      GITHUB_REF: '',
      GITHUB_EVENT_PATH: ''
    });
    const stderr = result.stderr?.toString() || '';

    expect(result.status).not.toBe(0);
    // The early --council guard did NOT fire...
    expect(stderr).not.toMatch(/--council flag requires a pull request/);
    // ...it fell through to the --ai-review PR auto-detect path instead.
    expect(stderr).toMatch(/--ai-review flag requires a pull request/);
  });
});
