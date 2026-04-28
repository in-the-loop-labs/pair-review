// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const { parseUnifiedDiffPatches } = require('./diff-file-list');

/**
 * @typedef {Object} Hunk
 * @property {string} header - Hunk header line, e.g. "@@ -10,5 +10,7 @@".
 * @property {string[]} lines - Diff lines including their leading marker
 *   ('+', '-', ' ', or the literal '\\ No newline at end of file' marker).
 */

/**
 * Split a single file's patch text into per-hunk structures.
 * @param {string} filePatch - Patch text for one file (with or without diff header).
 * @returns {Hunk[]} Array of hunks; empty when the patch contains no `@@` lines.
 */
function parseHunks(filePatch) {
  if (!filePatch) return [];

  const lines = filePatch.split('\n');
  const hunks = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { header: line, lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  if (current) hunks.push(current);

  for (const hunk of hunks) {
    while (hunk.lines.length > 0 && hunk.lines[hunk.lines.length - 1] === '') {
      hunk.lines.pop();
    }
  }

  return hunks;
}

/**
 * Parse a full unified diff into a Map of file path -> hunks.
 * @param {string} diffText - Full unified diff text spanning many files.
 * @returns {Map<string, Hunk[]>} Map keyed by the new path (or old path for deletions).
 */
function parseUnifiedDiffHunks(diffText) {
  const result = new Map();
  if (!diffText) return result;

  const patches = parseUnifiedDiffPatches(diffText);
  for (const [filePath, patch] of patches.entries()) {
    const hunks = parseHunks(patch);
    if (hunks.length === 0) continue;
    result.set(filePath, hunks);
  }

  return result;
}

module.exports = { parseHunks, parseUnifiedDiffHunks };
