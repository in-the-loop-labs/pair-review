// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Eval runner — orchestrates the evaluation flow by tying together config,
 * matcher, scorer, and pair-review's analysis API.
 *
 * Flow:
 *   1. For each repo in config
 *     a. For each PR number
 *        - Load ground truth from JSONL file
 *        - Invoke pair-review analysis (via HTTP API or provided suggestions)
 *        - Run matcher
 *        - Run scorer
 *        - Collect per-PR results
 *   2. Aggregate results across all PRs
 *   3. Return complete eval results
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSuggestions } from './matcher.js';
import { computeScores } from './scorer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = resolve(__dirname, '..');
const DEFAULT_FIXTURES_DIR = resolve(EVALS_DIR, 'fixtures');

// ---------------------------------------------------------------------------
// Ground truth loading
// ---------------------------------------------------------------------------

/**
 * Load a JSONL file and return an array of parsed objects.
 * Each line is a JSON object. Empty/blank lines are skipped.
 * If the file is empty, returns an empty array.
 * If the file doesn't exist, throws an error with a helpful message.
 *
 * @param {string} filePath — absolute path to a .jsonl file
 * @returns {object[]}
 */
export function loadGroundTruth(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(
      `Ground truth file not found: ${filePath}. ` +
        `Ensure the file exists and the path is correct.`,
    );
  }

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const results = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    results.push(JSON.parse(trimmed));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Run ID generation
// ---------------------------------------------------------------------------

/**
 * Create a run ID string from the current time and config defaults.
 * Format: `2026-02-07T14-30-00_claude-opus-balanced`
 *
 * @param {object} config — the loaded config object
 * @returns {string}
 */
export function generateRunId(config) {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/:/g, '-');

  const { provider, model, tier } = config.defaults;
  const parts = [provider, model, tier].filter(Boolean);

  return parts.length > 0 ? `${timestamp}_${parts.join('-')}` : timestamp;
}

// ---------------------------------------------------------------------------
// Default suggestions provider (placeholder)
// ---------------------------------------------------------------------------

/**
 * Placeholder HTTP-based suggestions provider. Throws until the real
 * integration with pair-review's analysis API is wired up.
 */
async function defaultSuggestionsProvider(repo, prNumber, config) {
  throw new Error(
    `HTTP-based pair-review integration not yet implemented. ` +
      `Use options.suggestionsProvider to provide suggestions for ${repo.github}#${prNumber}.`,
  );
}

// ---------------------------------------------------------------------------
// Ground truth file path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to a ground truth JSONL file for a given PR.
 * Files are named `pr-{NN}.jsonl` with zero-padded PR numbers.
 *
 * @param {string} groundTruthDir — directory containing JSONL files
 * @param {string} repoName — the repo name (used for subdirectory lookup)
 * @param {number} prNumber — the PR number
 * @returns {string} resolved file path
 */
function resolveGroundTruthPath(groundTruthDir, repoName, prNumber) {
  const paddedPr = String(prNumber).padStart(2, '0');
  const fileName = `pr-${paddedPr}.jsonl`;

  // Try repo-specific subdirectory first (e.g., ground-truth/eval-rails-app/pr-03.jsonl)
  const repoSpecific = resolve(groundTruthDir, repoName, fileName);
  if (existsSync(repoSpecific)) {
    return repoSpecific;
  }

  // Fall back to flat directory (e.g., ground-truth/pr-03.jsonl)
  return resolve(groundTruthDir, fileName);
}

// ---------------------------------------------------------------------------
// Score aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-PR results into a single combined result.
 *
 * Concatenates all matches/misses/falsePositives/bonusFinds across PRs and
 * re-runs computeScores on the combined set. This gives proper overall metrics
 * rather than averaging per-PR metrics (which would be misleading with unequal
 * ground truth counts).
 *
 * @param {Array<{ scores: object, matchResults: object }>} prResults
 * @param {object} [scoringConfig] — scoring config to pass to computeScores
 * @returns {object} aggregated scores from computeScores
 */
export function aggregateScores(prResults, scoringConfig = {}) {
  const combined = {
    matches: [],
    misses: [],
    falsePositives: [],
    bonusFinds: [],
  };

  for (const pr of prResults) {
    const mr = pr.matchResults;
    combined.matches.push(...(mr.matches || []));
    combined.misses.push(...(mr.misses || []));
    combined.falsePositives.push(...(mr.falsePositives || []));
    combined.bonusFinds.push(...(mr.bonusFinds || []));
  }

  return computeScores(combined, scoringConfig);
}

// ---------------------------------------------------------------------------
// Main eval entry point
// ---------------------------------------------------------------------------

/**
 * Run the full evaluation across all repos and PRs in the config.
 *
 * @param {object} config — the loaded config object (from loadConfig)
 * @param {object} [options={}]
 * @param {string} [options.groundTruthDir] — directory containing ground truth JSONL files
 * @param {Function} [options.suggestionsProvider] — async (repo, prNumber, config) => suggestions[]
 * @param {Function} [options.onProgress] — callback (event) => void for progress updates
 * @returns {Promise<object>} complete eval results
 */
export async function runEval(config, options = {}) {
  const {
    groundTruthDir = resolve(DEFAULT_FIXTURES_DIR, 'ground-truth'),
    suggestionsProvider = defaultSuggestionsProvider,
    onProgress,
  } = options;

  const startedAt = new Date().toISOString();
  const runId = generateRunId(config);

  const repos = {};
  const allPrResults = [];

  for (const repo of config.repos) {
    emitProgress(onProgress, { type: 'repo_start', repo: repo.name });

    const repoPrResults = [];
    const prs = {};

    for (const prNumber of repo.prs) {
      emitProgress(onProgress, {
        type: 'pr_start',
        repo: repo.name,
        pr: prNumber,
      });

      try {
        // 1. Load ground truth
        const gtPath = resolveGroundTruthPath(
          groundTruthDir,
          repo.name,
          prNumber,
        );
        let groundTruth;
        if (existsSync(gtPath)) {
          groundTruth = loadGroundTruth(gtPath);
        } else {
          // No ground truth file — treat as zero ground truth with a warning
          console.warn(
            `Warning: No ground truth file found for ${repo.name} PR #${prNumber} at ${gtPath}`,
          );
          groundTruth = [];
        }

        // 2. Get suggestions from provider
        const suggestions = await suggestionsProvider(repo, prNumber, config);

        // 3. Run matcher
        const matchResults = matchSuggestions(
          suggestions,
          groundTruth,
          config.matching,
        );

        // 4. Run scorer
        const scores = computeScores(matchResults, config.scoring);

        const prResult = {
          scores,
          matchResults,
          groundTruthCount: groundTruth.length,
          suggestionsCount: suggestions.length,
        };

        prs[prNumber] = prResult;
        repoPrResults.push(prResult);
        allPrResults.push(prResult);

        emitProgress(onProgress, {
          type: 'pr_complete',
          repo: repo.name,
          pr: prNumber,
          scores,
        });
      } catch (err) {
        // Log the error and record it, but don't abort the whole run
        console.error(
          `Error evaluating ${repo.name} PR #${prNumber}: ${err.message}`,
        );

        prs[prNumber] = { error: err.message };

        emitProgress(onProgress, {
          type: 'pr_complete',
          repo: repo.name,
          pr: prNumber,
          error: err.message,
        });
      }
    }

    // Aggregate across this repo's PRs (only successful ones)
    const repoOverall =
      repoPrResults.length > 0
        ? aggregateScores(repoPrResults, config.scoring)
        : null;

    repos[repo.name] = {
      overall: repoOverall,
      prs,
    };

    emitProgress(onProgress, {
      type: 'repo_complete',
      repo: repo.name,
      overall: repoOverall,
    });
  }

  const completedAt = new Date().toISOString();

  // Aggregate across all repos
  const overall =
    allPrResults.length > 0
      ? aggregateScores(allPrResults, config.scoring)
      : null;

  return {
    meta: {
      runId,
      startedAt,
      completedAt,
      config: {
        provider: config.defaults.provider,
        model: config.defaults.model,
        tier: config.defaults.tier,
      },
    },
    repos,
    overall,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely emit a progress event if a callback is provided.
 */
function emitProgress(onProgress, event) {
  if (typeof onProgress === 'function') {
    onProgress(event);
  }
}
