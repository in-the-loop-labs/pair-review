#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Quick scoring script — takes AI suggestions JSON from pair-review and
 * scores them against ground truth JSONL files.
 *
 * Usage:
 *   node evals/bin/score-suggestions.js --pr 2 --suggestions suggestions-pr2.json
 *   node evals/bin/score-suggestions.js --pr 2 --suggestions - < suggestions.json
 *
 * Or pipe suggestions from curl:
 *   curl -s http://localhost:7256/api/pr/.../2/ai-suggestions | \
 *     node evals/bin/score-suggestions.js --pr 2 --suggestions -
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchSuggestions } from '../src/matcher.js';
import { computeScores } from '../src/scorer.js';
import { loadGroundTruth } from '../src/runner.js';
import { loadConfig } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = resolve(__dirname, '..');
const FIXTURES_DIR = resolve(EVALS_DIR, 'fixtures');

// Parse args
const args = process.argv.slice(2);
const prIndex = args.indexOf('--pr');
const sugIndex = args.indexOf('--suggestions');
const repoIndex = args.indexOf('--repo');

if (prIndex === -1 || sugIndex === -1) {
  console.error('Usage: score-suggestions.js --pr <number> --suggestions <file-or--> [--repo <name>]');
  process.exit(1);
}

const prNumber = parseInt(args[prIndex + 1]);
const sugFile = args[sugIndex + 1];
const repoName = repoIndex !== -1 ? args[repoIndex + 1] : 'eval-rails-app';

// Load config for matching/scoring settings
const config = loadConfig({});

// Load ground truth
const paddedPr = String(prNumber).padStart(2, '0');
const gtPath = resolve(FIXTURES_DIR, 'ground-truth', repoName, `pr-${paddedPr}.jsonl`);
const groundTruth = loadGroundTruth(gtPath);

// Load suggestions
let suggestionsRaw;
if (sugFile === '-') {
  suggestionsRaw = readFileSync('/dev/stdin', 'utf-8');
} else {
  suggestionsRaw = readFileSync(sugFile, 'utf-8');
}

const suggestionsData = JSON.parse(suggestionsRaw);

// Handle both direct array and pair-review API response format
const rawSuggestions = Array.isArray(suggestionsData)
  ? suggestionsData
  : suggestionsData.suggestions || [];

// Normalize pair-review suggestion format to eval format
const suggestions = rawSuggestions.map(s => ({
  file: s.file,
  line_start: s.line_start,
  line_end: s.line_end,
  type: s.type,
  title: s.title,
  description: s.body || s.description || '',
  is_file_level: s.is_file_level || (s.line_start == null && s.line_end == null),
  confidence: s.ai_confidence || s.confidence,
}));

// Run matcher
const matchResults = matchSuggestions(suggestions, groundTruth, config.matching);

// Run scorer
const scores = computeScores(matchResults, config.scoring);

// Print results
console.log(`\n${'='.repeat(60)}`);
console.log(`  PR #${prNumber} — Eval Results (${repoName})`);
console.log(`${'='.repeat(60)}\n`);

console.log(`Ground truth:    ${groundTruth.length} issues`);
console.log(`AI suggestions:  ${suggestions.length} total`);
console.log(`Matches:         ${matchResults.matches.length}`);
console.log(`Misses:          ${matchResults.misses.length}`);
console.log(`False positives: ${matchResults.falsePositives.length}\n`);

const pct = (v) => v != null ? `${Math.round(v * 100)}%` : 'N/A';

if (scores.overall) {
  console.log(`Recall:          ${pct(scores.overall.recall)}`);
  console.log(`Precision:       ${pct(scores.overall.precision)}`);
  console.log(`F1:              ${pct(scores.overall.f1)}`);
  console.log(`Weighted Recall: ${pct(scores.overall.weightedRecall)}`);
}

if (matchResults.matches.length > 0) {
  console.log(`\n--- Matches ---`);
  for (const m of matchResults.matches) {
    const gt = m.groundTruth;
    const sg = m.suggestion;
    console.log(`  [${m.quality}] GT "${gt.title}" ↔ AI "${sg.title}"`);
    console.log(`    Score: ${m.score.toFixed(2)} | File match: ${m.details.fileMatch} | Line: ${m.details.lineMatch} | Type: ${m.details.typeMatch} | Semantic: ${m.details.semanticScore.toFixed(2)}`);
  }
}

if (matchResults.misses.length > 0) {
  console.log(`\n--- Misses (ground truth not matched) ---`);
  for (const miss of matchResults.misses) {
    console.log(`  [${miss.severity}] ${miss.title} (${miss.file}:${miss.line_start || 'file-level'})`);
  }
}

if (matchResults.falsePositives.length > 0) {
  console.log(`\n--- False Positives (AI suggestions not matched) ---`);
  for (const fp of matchResults.falsePositives) {
    console.log(`  [${fp.type}] ${fp.title} (${fp.file}:${fp.line_start || 'file-level'})`);
  }
}

if (scores.byType) {
  console.log(`\n--- By Type ---`);
  for (const [type, data] of Object.entries(scores.byType)) {
    console.log(`  ${type.padEnd(14)} recall=${pct(data.recall)} precision=${pct(data.precision)} (${data.matchCount}/${data.groundTruthCount} GT, ${data.suggestionCount} suggestions)`);
  }
}

console.log('');
