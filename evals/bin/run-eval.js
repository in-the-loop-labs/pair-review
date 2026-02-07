#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig } from '../src/config.js';
import { runEval, generateRunId } from '../src/runner.js';
import { writeJsonReport, formatJsonSummary } from '../src/reporters/json.js';
import {
  generateMarkdownReport,
  printMarkdownReport,
} from '../src/reporters/markdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = resolve(__dirname, '..');
const DEFAULT_RESULTS_DIR = resolve(EVALS_DIR, 'results');

// ---------------------------------------------------------------------------
// Progress logging (all to stderr so stdout stays clean for reports)
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(msg + '\n');
}

/**
 * Format a recall value as an integer percentage string.
 * @param {number|undefined|null} value
 * @returns {string}
 */
function pct(value) {
  if (value == null || typeof value !== 'number') return '0%';
  return `${Math.round(value * 100)}%`;
}

/**
 * onProgress callback for runEval — prints status lines to stderr.
 */
function handleProgress(event) {
  switch (event.type) {
    case 'repo_start':
      log(`\nEvaluating ${event.repo}...`);
      break;
    case 'pr_start':
      process.stderr.write(`  PR #${event.pr}...`);
      break;
    case 'pr_complete':
      if (event.error) {
        process.stderr.write(` error: ${event.error}\n`);
      } else if (event.scores?.overall) {
        process.stderr.write(
          ` done (recall: ${pct(event.scores.overall.recall)})\n`,
        );
      } else {
        process.stderr.write(' done\n');
      }
      break;
    case 'repo_complete':
      if (event.overall?.overall) {
        const o = event.overall.overall;
        log(
          `\n  Results: ${event.repo}\n` +
            `    Overall: recall=${pct(o.recall)} precision=${pct(o.precision)} F1=${pct(o.f1)}`,
        );
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Run command
// ---------------------------------------------------------------------------

async function runCommand(argv) {
  // Load config with CLI overrides
  const config = loadConfig({
    configPath: argv.config,
    provider: argv.provider,
    model: argv.model,
    tier: argv.tier,
    repo: argv.repo,
    prs: argv.prs,
  });

  const { provider, model, tier } = config.defaults;

  // Print header
  log('Pair-Review Eval Runner');
  log('=======================');
  log(`Provider: ${provider || 'default'} | Model: ${model || 'default'} | Tier: ${tier || 'default'}`);

  // Run eval
  const results = await runEval(config, { onProgress: handleProgress });

  // Determine output directory
  const runId = results.meta.runId;
  const outputDir = argv.output || resolve(DEFAULT_RESULTS_DIR, runId);

  // Write JSON results to disk
  writeJsonReport(results, outputDir);
  log(`\nWriting results to ${outputDir}/`);

  // Print report to stdout
  if (argv.json) {
    process.stdout.write(formatJsonSummary(results) + '\n');
  } else {
    printMarkdownReport(results);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Compare command
// ---------------------------------------------------------------------------

async function compareCommand(argv) {
  const [runId1, runId2] = argv._;

  if (!runId1 || !runId2) {
    log('Error: compare requires two run IDs');
    log('Usage: run-eval.js compare <run-id-1> <run-id-2>');
    return 1;
  }

  // Resolve run directories — support both absolute paths and relative to results dir
  const resolveRunDir = (id) => {
    const asAbsolute = resolve(id);
    if (existsSync(asAbsolute)) return asAbsolute;
    return resolve(DEFAULT_RESULTS_DIR, id);
  };

  const dir1 = resolveRunDir(runId1);
  const dir2 = resolveRunDir(runId2);

  // Load scores.json from each
  const loadScores = (dir, label) => {
    const scoresPath = resolve(dir, 'scores.json');
    if (!existsSync(scoresPath)) {
      throw new Error(`scores.json not found in ${dir} (run ID: ${label})`);
    }
    return JSON.parse(readFileSync(scoresPath, 'utf-8'));
  };

  let scores1, scores2;
  try {
    scores1 = loadScores(dir1, runId1);
    scores2 = loadScores(dir2, runId2);
  } catch (err) {
    log(`Error: ${err.message}`);
    return 1;
  }

  // Load meta.json for labels (optional — gracefully degrade)
  const loadMeta = (dir) => {
    const metaPath = resolve(dir, 'meta.json');
    if (!existsSync(metaPath)) return {};
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch {
      return {};
    }
  };

  const meta1 = loadMeta(dir1);
  const meta2 = loadMeta(dir2);

  const label1 = meta1.runId || runId1;
  const label2 = meta2.runId || runId2;

  // Extract overall metrics from scores
  const overall1 = scores1.overall || {};
  const overall2 = scores2.overall || {};

  // Print comparison table
  const header = `| Metric | ${label1} | ${label2} | Delta |`;
  const separator = '|--------|' + '-'.repeat(label1.length + 2) + '|' + '-'.repeat(label2.length + 2) + '|-------|';

  log('');
  log('# Eval Comparison');
  log('');
  log(header);
  log(separator);

  const metrics = [
    ['Recall', 'recall'],
    ['Precision', 'precision'],
    ['F1', 'f1'],
    ['Weighted Recall', 'weightedRecall'],
  ];

  for (const [displayName, key] of metrics) {
    const v1 = overall1[key];
    const v2 = overall2[key];
    const delta = (v1 != null && v2 != null)
      ? `${v2 - v1 >= 0 ? '+' : ''}${Math.round((v2 - v1) * 100)}pp`
      : 'N/A';
    log(`| ${displayName} | ${pct(v1)} | ${pct(v2)} | ${delta} |`);
  }

  const countMetrics = [
    ['Ground Truth', 'totalGroundTruth'],
    ['Suggestions', 'totalSuggestions'],
    ['Matches', 'totalMatches'],
    ['False Positives', 'totalFalsePositives'],
  ];

  for (const [displayName, key] of countMetrics) {
    const v1 = overall1[key] ?? 0;
    const v2 = overall2[key] ?? 0;
    const delta = v2 - v1;
    const deltaStr = `${delta >= 0 ? '+' : ''}${delta}`;
    log(`| ${displayName} | ${v1} | ${v2} | ${deltaStr} |`);
  }

  log('');
  return 0;
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const cli = yargs(hideBin(process.argv))
  .scriptName('run-eval')
  .usage('$0 [command] [options]')
  .command(
    '$0',
    'Run evaluation',
    (yargs) => {
      yargs
        .option('provider', {
          type: 'string',
          describe: 'Override AI provider (e.g., claude, gemini)',
        })
        .option('model', {
          type: 'string',
          describe: 'Override model name (e.g., opus, sonnet, pro)',
        })
        .option('tier', {
          type: 'string',
          describe: 'Override tier (fast, balanced, thorough)',
          choices: ['fast', 'balanced', 'thorough'],
        })
        .option('repo', {
          type: 'string',
          describe: 'Filter to specific repo name',
        })
        .option('prs', {
          type: 'string',
          describe: 'Override PR range (e.g., "1-5" or "1,3,5")',
        })
        .option('config', {
          type: 'string',
          describe: 'Path to config YAML file',
        })
        .option('output', {
          type: 'string',
          describe: 'Output directory for results (default: evals/results/{runId})',
        })
        .option('json', {
          type: 'boolean',
          describe: 'Output JSON instead of markdown',
          default: false,
        });
    },
    async (argv) => {
      try {
        const exitCode = await runCommand(argv);
        process.exit(exitCode);
      } catch (err) {
        log(`\nError: ${err.message}`);
        process.exit(1);
      }
    },
  )
  .command(
    'compare <run-id-1> <run-id-2>',
    'Compare two eval runs',
    (yargs) => {
      yargs
        .positional('run-id-1', {
          type: 'string',
          describe: 'First run ID or path',
        })
        .positional('run-id-2', {
          type: 'string',
          describe: 'Second run ID or path',
        });
    },
    async (argv) => {
      try {
        const exitCode = await compareCommand({
          _: [argv['run-id-1'], argv['run-id-2']],
        });
        process.exit(exitCode);
      } catch (err) {
        log(`\nError: ${err.message}`);
        process.exit(1);
      }
    },
  )
  .help()
  .alias('help', 'h')
  .strict();

// Parse and execute — yargs handles routing to the command handlers above
cli.parse();
