// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval, loadGroundTruth, aggregateScores } from '../src/runner.js';
import { loadConfig } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(EVALS_DIR, 'fixtures');
const GROUND_TRUTH_DIR = resolve(FIXTURES_DIR, 'ground-truth');
const SUGGESTIONS_DIR = resolve(FIXTURES_DIR, 'suggestions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a suggestion fixture JSON file.
 */
function loadSuggestions(repoName, fileName) {
  const filePath = resolve(SUGGESTIONS_DIR, repoName, fileName);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/**
 * Build a config object scoped to a single repo and a specific set of PRs.
 */
function buildConfig(prs) {
  const base = loadConfig();
  return {
    ...base,
    repos: [
      {
        name: 'eval-rails-app',
        github: 'in-the-loop-labs/eval-rails-app',
        prs,
      },
    ],
  };
}

/**
 * Create a suggestionsProvider that maps (repo, prNumber) to a fixture file.
 * @param {Record<number, string>} prToFile — maps PR number to fixture filename
 */
function fixtureProvider(prToFile) {
  return async (repo, prNumber) => {
    const fileName = prToFile[prNumber];
    if (!fileName) return [];
    return loadSuggestions(repo.name, fileName);
  };
}

// ===========================================================================
// Test: PR 1 — clean baseline (no ground truth, no suggestions)
// ===========================================================================
describe('PR 1: clean baseline', () => {
  it('produces zero matches and zero misses with empty ground truth and empty suggestions', async () => {
    const config = buildConfig([1]);
    const provider = fixtureProvider({ 1: 'pr-01-clean.json' });

    const result = await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
    });

    // Should have one repo with one PR
    expect(result.repos['eval-rails-app']).toBeDefined();
    const pr1 = result.repos['eval-rails-app'].prs[1];
    expect(pr1).toBeDefined();
    expect(pr1.error).toBeUndefined();

    // Zero ground truth, zero suggestions
    expect(pr1.groundTruthCount).toBe(0);
    expect(pr1.suggestionsCount).toBe(0);

    // Match results should all be empty
    expect(pr1.matchResults.matches).toHaveLength(0);
    expect(pr1.matchResults.misses).toHaveLength(0);
    expect(pr1.matchResults.falsePositives).toHaveLength(0);

    // Scores: recall and precision are 0 (safeDivide returns 0 for 0/0)
    const overall = pr1.scores.overall;
    expect(overall.recall).toBe(0);
    expect(overall.precision).toBe(0);
    expect(overall.f1).toBe(0);
    expect(overall.totalGroundTruth).toBe(0);
    expect(overall.totalSuggestions).toBe(0);
    expect(overall.totalMatches).toBe(0);
    expect(overall.totalMisses).toBe(0);
    expect(overall.totalFalsePositives).toBe(0);
  });
});

// ===========================================================================
// Test: PR 2 — good suggestions produce high recall/precision
// ===========================================================================
describe('PR 2: good suggestions', () => {
  it('matches all 4 ground truth issues with high recall and precision', async () => {
    const config = buildConfig([2]);
    const provider = fixtureProvider({ 2: 'pr-02-good.json' });

    const result = await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
    });

    const pr2 = result.repos['eval-rails-app'].prs[2];
    expect(pr2.error).toBeUndefined();

    // 4 ground truth issues, 4 suggestions
    expect(pr2.groundTruthCount).toBe(4);
    expect(pr2.suggestionsCount).toBe(4);

    // All 4 should match
    expect(pr2.matchResults.matches).toHaveLength(4);
    expect(pr2.matchResults.misses).toHaveLength(0);
    expect(pr2.matchResults.falsePositives).toHaveLength(0);

    // Perfect recall and precision
    expect(pr2.scores.overall.recall).toBe(1);
    expect(pr2.scores.overall.precision).toBe(1);
    expect(pr2.scores.overall.f1).toBe(1);
    expect(pr2.scores.overall.totalMatches).toBe(4);
    expect(pr2.scores.overall.totalMisses).toBe(0);
    expect(pr2.scores.overall.totalFalsePositives).toBe(0);

    // Verify each match has a quality and score
    for (const match of pr2.matchResults.matches) {
      expect(match.quality).toBeDefined();
      expect(match.score).toBeGreaterThan(0);
      expect(match.groundTruth).toBeDefined();
      expect(match.suggestion).toBeDefined();
    }
  });
});

// ===========================================================================
// Test: PR 3 — good suggestions produce high recall/precision
// ===========================================================================
describe('PR 3: good suggestions', () => {
  it('matches all 5 ground truth issues with high recall and precision', async () => {
    const config = buildConfig([3]);
    const provider = fixtureProvider({ 3: 'pr-03-good.json' });

    const result = await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
    });

    const pr3 = result.repos['eval-rails-app'].prs[3];
    expect(pr3.error).toBeUndefined();

    // 5 ground truth issues, 5 suggestions
    expect(pr3.groundTruthCount).toBe(5);
    expect(pr3.suggestionsCount).toBe(5);

    // All 5 should match
    expect(pr3.matchResults.matches).toHaveLength(5);
    expect(pr3.matchResults.misses).toHaveLength(0);
    expect(pr3.matchResults.falsePositives).toHaveLength(0);

    // Perfect recall and precision
    expect(pr3.scores.overall.recall).toBe(1);
    expect(pr3.scores.overall.precision).toBe(1);
    expect(pr3.scores.overall.f1).toBe(1);
    expect(pr3.scores.overall.totalMatches).toBe(5);
    expect(pr3.scores.overall.totalMisses).toBe(0);
    expect(pr3.scores.overall.totalFalsePositives).toBe(0);

    // No notable misses (all matched)
    expect(pr3.scores.notableMisses).toHaveLength(0);
  });
});

// ===========================================================================
// Test: PR 3 — poor suggestions produce low recall, false positives
// ===========================================================================
describe('PR 3: poor suggestions', () => {
  it('produces low recall and has false positives', async () => {
    const config = buildConfig([3]);
    const provider = fixtureProvider({ 3: 'pr-03-poor.json' });

    const result = await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
    });

    const pr3 = result.repos['eval-rails-app'].prs[3];
    expect(pr3.error).toBeUndefined();

    // 5 ground truth issues, 3 poor suggestions
    expect(pr3.groundTruthCount).toBe(5);
    expect(pr3.suggestionsCount).toBe(3);

    // Most ground truth issues should be missed
    expect(pr3.matchResults.misses.length).toBeGreaterThan(0);

    // Recall should be low — at most a few partial matches out of 5
    expect(pr3.scores.overall.recall).toBeLessThan(0.5);

    // There should be false positives (poor suggestions that don't match anything)
    expect(pr3.matchResults.falsePositives.length).toBeGreaterThan(0);
    expect(pr3.scores.overall.totalFalsePositives).toBeGreaterThan(0);

    // Notable misses should include the critical/high severity ones that were missed
    // PR 3 has critical (03-001) and high (03-002, 03-004) severity issues
    const notableMisses = pr3.scores.notableMisses;
    expect(notableMisses.length).toBeGreaterThan(0);

    // Verify notable misses are sorted by severity (critical before high)
    for (let i = 1; i < notableMisses.length; i++) {
      const severityOrder = { critical: 0, high: 1 };
      const prev = severityOrder[notableMisses[i - 1].severity] ?? 99;
      const curr = severityOrder[notableMisses[i].severity] ?? 99;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });
});

// ===========================================================================
// Test: Multi-PR run aggregates correctly across PRs 1-3
// ===========================================================================
describe('Multi-PR run (PRs 1-3)', () => {
  it('aggregates scores correctly across all PRs', async () => {
    const config = buildConfig([1, 2, 3]);
    const provider = fixtureProvider({
      1: 'pr-01-clean.json',
      2: 'pr-02-good.json',
      3: 'pr-03-good.json',
    });

    const result = await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
    });

    // All three PRs should be present in the breakdown
    const repo = result.repos['eval-rails-app'];
    expect(repo.prs[1]).toBeDefined();
    expect(repo.prs[2]).toBeDefined();
    expect(repo.prs[3]).toBeDefined();

    // No errors on any PR
    expect(repo.prs[1].error).toBeUndefined();
    expect(repo.prs[2].error).toBeUndefined();
    expect(repo.prs[3].error).toBeUndefined();

    // Per-repo overall should aggregate all 3 PRs
    const repoOverall = repo.overall;
    expect(repoOverall).not.toBeNull();

    // Combined ground truth: 0 + 4 + 5 = 9
    // Combined suggestions: 0 + 4 + 5 = 9
    // Combined matches: 0 + 4 + 5 = 9
    expect(repoOverall.overall.totalGroundTruth).toBe(9);
    expect(repoOverall.overall.totalSuggestions).toBe(9);
    expect(repoOverall.overall.totalMatches).toBe(9);
    expect(repoOverall.overall.totalMisses).toBe(0);
    expect(repoOverall.overall.totalFalsePositives).toBe(0);

    // Perfect aggregate recall and precision since PR 2 and 3 are perfect, PR 1 is empty
    expect(repoOverall.overall.recall).toBe(1);
    expect(repoOverall.overall.precision).toBe(1);
    expect(repoOverall.overall.f1).toBe(1);

    // Top-level overall should match repo overall (only one repo)
    expect(result.overall).not.toBeNull();
    expect(result.overall.overall.totalGroundTruth).toBe(9);
    expect(result.overall.overall.totalMatches).toBe(9);
    expect(result.overall.overall.recall).toBe(1);
    expect(result.overall.overall.precision).toBe(1);

    // Meta should be populated
    expect(result.meta).toBeDefined();
    expect(result.meta.runId).toBeDefined();
    expect(result.meta.startedAt).toBeDefined();
    expect(result.meta.completedAt).toBeDefined();
    expect(result.meta.config).toBeDefined();
  });

  it('aggregates correctly when some PRs have poor suggestions', async () => {
    const config = buildConfig([1, 2, 3]);
    const provider = fixtureProvider({
      1: 'pr-01-clean.json',
      2: 'pr-02-good.json',
      3: 'pr-03-poor.json', // poor suggestions for PR 3
    });

    const result = await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
    });

    const repo = result.repos['eval-rails-app'];
    const repoOverall = repo.overall;

    // PR 2 contributes 4 matches from 4 ground truth
    // PR 3 poor contributes few matches from 5 ground truth
    // Total ground truth: 0 + 4 + 5 = 9
    expect(repoOverall.overall.totalGroundTruth).toBe(9);

    // Overall recall should be between 0 and 1 (PR 2 is perfect, PR 3 is poor)
    expect(repoOverall.overall.recall).toBeGreaterThan(0);
    expect(repoOverall.overall.recall).toBeLessThan(1);

    // There should be some misses from PR 3's poor suggestions
    expect(repoOverall.overall.totalMisses).toBeGreaterThan(0);

    // There should be some false positives from PR 3's poor suggestions
    expect(repoOverall.overall.totalFalsePositives).toBeGreaterThan(0);

    // The by-type breakdown should include types from both PRs
    expect(Object.keys(repoOverall.byType).length).toBeGreaterThan(0);

    // The by-severity breakdown should include severities from both PRs
    expect(Object.keys(repoOverall.bySeverity).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Test: Progress callback receives expected events
// ===========================================================================
describe('Progress events', () => {
  it('emits repo_start, pr_start, pr_complete, and repo_complete events', async () => {
    const config = buildConfig([1, 2]);
    const provider = fixtureProvider({
      1: 'pr-01-clean.json',
      2: 'pr-02-good.json',
    });

    const events = [];
    const onProgress = (event) => events.push(event);

    await runEval(config, {
      groundTruthDir: GROUND_TRUTH_DIR,
      suggestionsProvider: provider,
      onProgress,
    });

    // Should have: repo_start, pr_start(1), pr_complete(1), pr_start(2), pr_complete(2), repo_complete
    const types = events.map((e) => e.type);
    expect(types).toContain('repo_start');
    expect(types).toContain('pr_start');
    expect(types).toContain('pr_complete');
    expect(types).toContain('repo_complete');

    // repo_start should come first
    expect(types[0]).toBe('repo_start');

    // repo_complete should come last
    expect(types[types.length - 1]).toBe('repo_complete');

    // Each PR should have a start and complete
    const prStarts = events.filter((e) => e.type === 'pr_start');
    const prCompletes = events.filter((e) => e.type === 'pr_complete');
    expect(prStarts).toHaveLength(2);
    expect(prCompletes).toHaveLength(2);

    // pr_complete events for successful PRs should include scores
    const pr2Complete = prCompletes.find((e) => e.pr === 2);
    expect(pr2Complete.scores).toBeDefined();
    expect(pr2Complete.error).toBeUndefined();
  });
});
