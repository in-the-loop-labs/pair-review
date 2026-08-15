// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Integration test: `--local <alt-host URL>` must be rejected as a URL, with a
 * message naming the hosts the install accepts.
 *
 * parseArgs() runs config-free, so it can only spot an explicit `scheme://`
 * input. A scheme-less URL for a CONFIGURED alt host needs config, and several
 * branches downstream (the instruction handoff, handleHeadlessDelegated, the
 * headless local path) resolve `flags.localPath` straight to a filesystem path
 * — so main() re-runs the guard once config is loaded. Without that re-check the
 * user gets a git-root/path error instead.
 *
 * Driven through --headless --json because that failure envelope lands on stdout
 * as parseable JSON, and the guard throws before any DB/server/git/network work
 * (the same fast path tests/integration/headless-json-error.test.js relies on).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.join(__dirname, '../..');

function runCli(args, homeDir) {
  // process.execPath (not literal 'node') so the child runs under the SAME Node
  // major as the runner — better-sqlite3 only loads under its build ABI.
  // cwd is the temp HOME, not the repo: loadConfig() also merges any
  // project-local `.pair-review/config.*.json` from the working directory, and
  // this repo carries a gitignored one that would leak its hosts into the copy.
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/pair-review.js'), ...args], {
    cwd: homeDir,
    env: {
      ...process.env,
      HOME: homeDir,
      GITHUB_TOKEN: '',
      PAIR_REVIEW_NO_OPEN: '1'
    },
    timeout: 15000
  });
}

async function writeConfig(homeDir, config) {
  const configDir = path.join(homeDir, '.pair-review');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
}

function errorMessage(result) {
  const stdout = (result.stdout?.toString() || '').trim();
  return JSON.parse(stdout).error.message;
}

describe('--local URL guard (config-aware)', () => {
  let testHomeDir;

  beforeEach(async () => {
    testHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-local-url-guard-'));
  });

  afterEach(async () => {
    if (testHomeDir) {
      await fs.rm(testHomeDir, { recursive: true, force: true });
    }
  });

  it('rejects a scheme-less alt-host URL and names the alt host', async () => {
    await writeConfig(testHomeDir, {
      github_token: '',
      port: 7247,
      theme: 'light',
      enable_graphite: true,
      repos: {
        'guardteam/guardproject': {
          api_host: 'ghe.guard.example',
          links: {
            external: {
              name: 'GuardHost',
              label: 'Open on GuardHost',
              url_template: 'https://ghe.guard.example/{owner}/{repo}/pull/{number}'
            }
          }
        }
      }
    });

    const result = runCli(
      ['--local', 'ghe.guard.example/guardteam/guardproject/pull/1', '--headless', '--json'],
      testHomeDir
    );

    expect(result.status).toBe(1);
    // Naming GuardHost and Graphite proves the guard ran WITH config: parseArgs'
    // config-free pre-check cannot see either, and would not have matched this
    // scheme-less input at all.
    expect(errorMessage(result)).toBe(
      'Local reviews require a filesystem path, not a URL. '
      + 'Pass GitHub, Graphite, or GuardHost URLs as PR review inputs instead.'
    );
  });

  it('keeps the config-free pre-check for an explicit scheme, with host-neutral copy', async () => {
    await writeConfig(testHomeDir, {
      github_token: '',
      port: 7247,
      theme: 'light',
      enable_graphite: true
    });

    // parseArgs() rejects this before config is threaded in, so the message
    // omits the host clause rather than naming a list it cannot know.
    const result = runCli(
      ['--local', 'https://github.com/owner/repo/pull/1', '--headless', '--json'],
      testHomeDir
    );

    expect(result.status).toBe(1);
    expect(errorMessage(result)).toBe(
      'Local reviews require a filesystem path, not a URL. '
      + 'Pass PR URLs as PR review inputs instead.'
    );
  });
});

// The negative case — a filesystem path must survive the guard — is covered at
// the unit level in tests/unit/local-path-input.test.js. Exercising it through
// the CLI would have to run past the guard into git/server work, which is both
// slow and prone to contacting a real dev server on the configured port.
