// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the council-related CLI surface — the flags
 * (--list-councils, --council) and the `pair-review council <verb>`
 * subcommand — exercising the real CLI as a spawned child process.
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
import { writeFileSync } from 'fs';
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
 * @param {string[]} [unsetEnv] - env vars to DELETE from the child's
 *   environment. Needed for PAIR_REVIEW_NO_FILE_COUNCILS, which vitest sets
 *   globally and the child inherits: only an absent key lets the real
 *   file-council loader run.
 */
function runCli(args, testHomeDir, extraEnv = {}, unsetEnv = []) {
  // Use process.execPath (not the literal 'node') so the child runs under the
  // SAME Node major as the test runner — better-sqlite3 is a native module and
  // only loads under the Node ABI its binary was built for.
  //
  // cwd is the temp HOME, NOT the repo root: loadConfig reads a project-layer
  // config from <cwd>/.pair-review/, so running from the repo would leak the
  // developer's local .pair-review/config.local.json (e.g. a custom db_name)
  // into the child and break DB isolation.
  const env = {
    ...process.env,
    HOME: testHomeDir,
    GITHUB_TOKEN: '',
    PAIR_REVIEW_NO_OPEN: '1'
  };
  // resolveDbName() (src/config.js) puts PAIR_REVIEW_DB_NAME ABOVE config.db_name,
  // so an inherited value repoints the child at a database seedCouncil never
  // wrote — the test would then seed one file and assert against another. Drop it
  // for the same reason HOME and cwd are pinned. Deleted BEFORE extraEnv is
  // applied so a test that deliberately sets it still wins.
  delete env.PAIR_REVIEW_DB_NAME;
  Object.assign(env, extraEnv);
  for (const key of unsetEnv) {
    delete env[key];
  }
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/pair-review.js'), ...args], {
    cwd: testHomeDir,
    env,
    timeout: 20000,
    // `council show` of a large council deliberately exceeds the default 1MB
    // stdout cap; without this spawnSync reports ENOBUFS instead of the document.
    maxBuffer: 32 * 1024 * 1024
  });
}

/**
 * Seed a council into the test HOME's database via a child node process using
 * production code (no schema duplication). Scalar fields are passed via env vars
 * to avoid inline-script quoting hazards; the config goes through a file (see
 * below).
 */
function seedCouncil(testHomeDir, { id, name, type, config = SAMPLE_CONFIG }) {
  // The config travels by FILE, not by env var: the pipe-buffer regression test
  // seeds a council whose config is far past the OS limit on an environment
  // block, which would fail the spawn outright (E2BIG).
  const configPath = path.join(testHomeDir, `seed-config-${id}.json`);
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');

  const seedScript = `
    const { readFileSync } = require('fs');
    const { initializeDatabase, CouncilRepository } = require(process.env.SEED_DB_MODULE);
    (async () => {
      const db = await initializeDatabase('database.db');
      await new CouncilRepository(db).create({
        id: process.env.SEED_COUNCIL_ID,
        name: process.env.SEED_COUNCIL_NAME,
        type: process.env.SEED_COUNCIL_TYPE,
        config: JSON.parse(readFileSync(process.env.SEED_COUNCIL_CONFIG_FILE, 'utf-8'))
      });
      db.close();
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  const env = {
    ...process.env,
    HOME: testHomeDir,
    SEED_DB_MODULE: DB_MODULE,
    SEED_COUNCIL_ID: id,
    SEED_COUNCIL_NAME: name,
    SEED_COUNCIL_TYPE: type,
    SEED_COUNCIL_CONFIG_FILE: configPath,
    PAIR_REVIEW_NO_OPEN: '1'
  };
  // The seed pins 'database.db' explicitly while the CLI child resolves its name
  // through resolveDbName(); drop the env override here too so both halves of
  // every test are stated against the same file and can never drift apart.
  delete env.PAIR_REVIEW_DB_NAME;
  const result = spawnSync(process.execPath, ['-e', seedScript], {
    cwd: REPO_ROOT,
    env,
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

  // The only test that exercises the REAL file-council loader end-to-end: the
  // child reads an actual `~/.pair-review/councils/*.json` off the temp HOME.
  it('--list-councils loads a council file from the config dir and marks it as file-sourced', async () => {
    const councilsDir = path.join(testHomeDir, '.pair-review', 'councils');
    await fs.mkdir(councilsDir, { recursive: true });
    await fs.writeFile(
      path.join(councilsDir, 'dream-team.council.json'),
      JSON.stringify({
        pair_review_council: 1,
        name: 'Dream Team',
        type: 'council',
        config: {
          voices: [{ provider: 'claude', model: 'sonnet' }],
          levels: { '1': true }
        }
      }, null, 2)
    );

    const result = runCli(['--list-councils'], testHomeDir, {}, ['PAIR_REVIEW_NO_FILE_COUNCILS']);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    // The full `file:` id is the printed handle (a shortId would not resolve).
    expect(stdout).toContain('file:dream-team');
    expect(stdout).toContain('Dream Team');
    expect(stdout).toMatch(/SOURCE/);
    expect(stdout).toMatch(/file:dream-team.*\bfile\b/);
    // And it is offered as a --council handle in the closing hint.
    expect(stdout).toContain('--council file:dream-team');
  });

  it('council list exits 0 and prints the seeded council', () => {
    const councilId = uuidv4();
    seedCouncil(testHomeDir, { id: councilId, name: 'Subcommand Council', type: 'council' });

    const result = runCli(['council', 'list'], testHomeDir);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    expect(stdout).toContain(councilId.slice(0, 8));
    expect(stdout).toContain('Subcommand Council');
  });

  it('council show prints a parseable council document on a clean stdout', () => {
    const councilId = uuidv4();
    seedCouncil(testHomeDir, { id: councilId, name: 'Shown Council', type: 'advanced' });

    const result = runCli(['council', 'show', 'Shown Council'], testHomeDir);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    // The whole point of the verb: stdout is the document and nothing else, so
    // `council show <handle> > file.json` produces a usable file. Database
    // narration ("Database schema is up to date...") must not leak into it.
    expect(JSON.parse(stdout)).toEqual({
      pair_review_council: 1,
      name: 'Shown Council',
      type: 'advanced',
      config: SAMPLE_CONFIG
    });
  });

  // Regression: `process.exit(code)` immediately after writing the document
  // truncated it. Writes to a pipe are asynchronous and a single write(2) to a
  // pipe can only move as much as the OS buffer holds (64KB on macOS/Linux), so
  // exiting in the same tick discards everything still queued — and the exit
  // code stays 0, making the loss silent. Seed a council whose document is
  // several hundred KB, capture it through a pipe, and require the WHOLE thing
  // back. This fails (JSON.parse on a severed document) without the drain.
  it('council show does not truncate a document larger than the stdout pipe buffer', () => {
    const councilId = uuidv4();
    const voices = Array.from({ length: 1500 }, (_, i) => ({
      provider: 'claude',
      model: 'sonnet',
      tier: 'balanced',
      // Filler so the serialized document clears the pipe buffer many times over.
      note: `voice-${i}-${'x'.repeat(240)}`
    }));
    const bigConfig = {
      levels: {
        '1': { enabled: true, voices },
        '2': { enabled: false, voices: [] },
        '3': { enabled: false, voices: [] }
      }
    };
    seedCouncil(testHomeDir, { id: councilId, name: 'Huge Council', type: 'advanced', config: bigConfig });

    const result = runCli(['council', 'show', 'Huge Council'], testHomeDir);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    // Well past a 64KB pipe buffer, so a same-tick exit cannot have flushed it.
    expect(stdout.length).toBeGreaterThan(400 * 1024);
    // Parses in full, last voice included — the tail is what truncation eats.
    const doc = JSON.parse(stdout);
    expect(doc.config.levels['1'].voices).toHaveLength(1500);
    expect(doc.config.levels['1'].voices[1499].note).toContain('voice-1499-');
  });

  it('council show exits non-zero with a clear error for an unknown handle', () => {
    seedCouncil(testHomeDir, { id: uuidv4(), name: 'Subcommand Council', type: 'council' });

    const result = runCli(['council', 'show', 'definitely-not-a-real-handle'], testHomeDir);
    const stderr = result.stderr?.toString() || '';

    expect(result.status).not.toBe(0);
    expect(stderr).toMatch(/No council matches/);
  });

  it('council --help prints council usage, not the global help', () => {
    const result = runCli(['council', '--help'], testHomeDir);
    const stdout = result.stdout?.toString() || '';

    expect(result.status).toBe(0);
    expect(stdout).toContain('pair-review council <command>');
    // The global help would list --ai-draft; the subcommand help must not.
    expect(stdout).not.toContain('--ai-draft');
  });

  it('council rejects an unknown flag instead of running the verb', () => {
    const result = runCli(['council', 'list', '--not-a-flag'], testHomeDir);
    const stderr = result.stderr?.toString() || '';

    expect(result.status).toBe(1);
    expect(stderr).toContain('Unknown flag: --not-a-flag');
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
