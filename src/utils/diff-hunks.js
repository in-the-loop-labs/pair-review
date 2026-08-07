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

// --- live-validation filler block for src/utils/diff-hunks.js (throwaway PR) ---
// diff_hunks filler line 1: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 2: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 3: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 4: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 5: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 6: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 7: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 8: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 9: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 10: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 11: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 12: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 13: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 14: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 15: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 16: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 17: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 18: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 19: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 20: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 21: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 22: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 23: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 24: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 25: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 26: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 27: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 28: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 29: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 30: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 31: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 32: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 33: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 34: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 35: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 36: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 37: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 38: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 39: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 40: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 41: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 42: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 43: synthetic content so the diff is large enough to virtualize.
// diff_hunks filler line 44: synthetic content so the diff is large enough to virtualize.
// --- end live-validation filler block ---

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
