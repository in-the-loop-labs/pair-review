// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Write eval results to three separate JSON files in the output directory:
 *   - meta.json    — run metadata
 *   - scores.json  — aggregated scores (overall + per-repo)
 *   - details.json — full per-PR breakdowns including individual matches
 *
 * Creates the output directory (recursively) if it doesn't exist.
 *
 * @param {object} evalResults - The complete eval results object
 * @param {string} outputDir  - Directory to write output files into
 * @returns {string} The output directory path
 */
export function writeJsonReport(evalResults, outputDir) {
  mkdirSync(outputDir, { recursive: true });

  const meta = evalResults.meta || {};
  // Support both runner output shape (evalResults.overall + evalResults.repos) and flat shape
  const scores = evalResults.overall || evalResults.scores || {};
  const details = evalResults.repos || evalResults.details || {};

  writeFileSync(
    join(outputDir, 'meta.json'),
    JSON.stringify(meta, null, 2) + '\n',
    'utf-8',
  );

  writeFileSync(
    join(outputDir, 'scores.json'),
    JSON.stringify(scores, null, 2) + '\n',
    'utf-8',
  );

  writeFileSync(
    join(outputDir, 'details.json'),
    JSON.stringify(details, null, 2) + '\n',
    'utf-8',
  );

  return outputDir;
}

/**
 * Return a compact JSON string of just the overall scores (for quick inspection).
 *
 * @param {object} evalResults - The complete eval results object
 * @returns {string} Compact JSON string of overall scores
 */
export function formatJsonSummary(evalResults) {
  const scores = evalResults?.overall || evalResults?.scores || {};
  const overall = scores.overall || {};
  return JSON.stringify(overall);
}
