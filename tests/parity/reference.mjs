// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Take the reference side of the parity checks from a second checkout of the
 * repository (layers L4 and L6 of plans/codeview-virtualized-diff.md).
 *
 * The parity scripts compare this tree with the application as it was before
 * the migration to the virtualized viewer. That application is not in this
 * tree any more, so its side comes from a checkout that still has it: a
 * `git worktree` of the commit, outside this repository's directory, with
 * `node_modules` and the vendor bundle in place (`pnpm install`, or a link
 * to this tree's `node_modules` plus `node scripts/build-pierre-diffs.mjs`
 * there when the dependencies are the same).
 *
 * This script runs the checkout's OWN copies of the parity scripts, one after
 * the other (never two browsers at once), and saves what they write:
 *
 *   <out>/golden/            dump.mjs: one JSON per configuration
 *   <out>/visual/reference/  visual.mjs --capture reference: geometry JSON and screenshots
 *   <out>/perf.json          perf.mjs: medians and samples
 *   <out>/REFERENCE.json     the checkout's commit, whether it was clean, when, and each step's exit status
 *
 * The saved directory is then the reference of
 *
 *   node tests/parity/compare.mjs <out>/golden <dump of this tree>
 *   node tests/parity/visual.mjs --out <dir> --reference <out>/visual/reference
 *   node tests/parity/perf.mjs --out <file.json> --reference <out>/perf.json
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=... node tests/parity/reference.mjs --checkout <path> --out <dir>
 *     [--only golden,visual,perf] [--golden "<arguments for dump.mjs>"]
 *     [--visual "<arguments for visual.mjs>"] [--perf "<arguments for perf.mjs>"]
 *
 * The checkout's scripts run with a minimal environment (PATH, HOME, the
 * browsers' path), so nothing this shell exports changes what they capture.
 * Do not run it while the E2E suite is running.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const STEPS = ['golden', 'visual', 'perf'];

function parseArgs(argv) {
  const args = { checkout: null, out: null, only: STEPS, golden: '', visual: '', perf: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    args[key] = key === 'only' ? value.split(',') : value;
  }
  if (!args.checkout || !args.out) throw new Error('--checkout <path> and --out <dir> are required');
  for (const step of args.only) {
    if (!STEPS.includes(step)) throw new Error(`Unknown step "${step}" (one of ${STEPS.join(', ')})`);
  }
  return args;
}

/** What a browser and the test server need, and nothing this shell happens to export. */
function minimalEnvironment() {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

const words = (text) => text.split(/\s+/).filter(Boolean);

function git(checkout, ...argv) {
  const child = spawnSync('git', argv, { cwd: checkout, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`git ${argv.join(' ')} failed in ${checkout}: ${child.stderr}`);
  return child.stdout.trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const checkout = fs.realpathSync(path.resolve(args.checkout));
  const out = path.resolve(args.out);
  const here = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  if (checkout === here || checkout.startsWith(`${here}${path.sep}`)) {
    throw new Error('the reference checkout must be outside this tree (a `git worktree` elsewhere)');
  }
  for (const needed of ['tests/parity/dump.mjs', 'node_modules', 'public/js/vendor/pierre-diffs.js']) {
    if (!fs.existsSync(path.join(checkout, needed))) throw new Error(`${checkout} has no ${needed}`);
  }
  fs.mkdirSync(out, { recursive: true });

  const commands = {
    golden: ['tests/parity/dump.mjs', '--out', path.join(out, 'golden'), ...words(args.golden)],
    visual: ['tests/parity/visual.mjs', '--out', path.join(out, 'visual'), '--capture', 'reference', ...words(args.visual)],
    perf: ['tests/parity/perf.mjs', '--out', path.join(out, 'perf.json'), ...words(args.perf)],
  };
  const record = {
    checkout,
    commit: git(checkout, 'rev-parse', 'HEAD'),
    subject: git(checkout, 'log', '-1', '--format=%s'),
    // Changes to tracked files; the linked node_modules and the built bundle are not tracked.
    clean: git(checkout, 'status', '--porcelain', '--untracked-files=no') === '',
    started: new Date().toISOString(),
    steps: {},
  };
  let failed = false;
  for (const step of STEPS.filter((name) => args.only.includes(name))) {
    const [script, ...rest] = commands[step];
    const started = Date.now();
    console.log(`\n== ${step}: node ${script} ${rest.join(' ')}  (in ${checkout})`);
    const child = spawnSync(process.execPath, [path.join(checkout, script), ...rest], { cwd: checkout, env: minimalEnvironment(), stdio: 'inherit' });
    record.steps[step] = { arguments: rest, exit: child.status, seconds: Math.round((Date.now() - started) / 1000) };
    if (child.status !== 0) failed = true;
  }
  record.ended = new Date().toISOString();
  // A later run of some steps only keeps the record of the others.
  const recordPath = path.join(out, 'REFERENCE.json');
  const earlier = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null;
  if (earlier && earlier.commit === record.commit) record.steps = { ...earlier.steps, ...record.steps };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nWrote ${recordPath}`);
  if (failed) process.exit(1);
}

main();
