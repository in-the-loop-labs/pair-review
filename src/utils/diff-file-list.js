// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { promisify } = require('util');
const { exec } = require('child_process');
const { queryOne } = require('../database');
const { GIT_DIFF_FLAGS } = require('../git/diff-flags');
const { normalizePath, resolveRenamedFile } = require('./paths');

const execPromise = promisify(exec);

/**
 * Parse a unified diff into a map of file path -> per-file patch.
 * Uses the "b/" path from the diff header as the canonical file path.
 *
 * @param {string} diff - Full unified diff
 * @returns {Map<string, string>} Map of file paths to full patch text
 */
function parseUnifiedDiffPatches(diff) {
  const filePatchMap = new Map();
  if (!diff) return filePatchMap;

  const parts = diff.split(/(?=^diff --git )/m);

  for (const part of parts) {
    if (!part.trim()) continue;

    const match = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (match) {
      filePatchMap.set(match[2], part);
    }
  }

  return filePatchMap;
}

/**
 * Count additions and deletions inside a single patch body.
 *
 * @param {string} patch - Per-file patch text
 * @returns {{ insertions: number, deletions: number }}
 */
function countPatchStats(patch) {
  let insertions = 0;
  let deletions = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      insertions++;
    } else if (line.startsWith('-') && !line.startsWith('--- ')) {
      deletions++;
    }
  }

  return { insertions, deletions };
}

/**
 * Merge changed_files metadata with the authoritative file list from the diff.
 * This recovers files when cached changed_files were derived from abbreviated
 * diff --stat output and no longer match the full patch headers.
 *
 * @param {Array<object|string>} changedFiles - Existing changed_files array
 * @param {string} diff - Full unified diff
 * @returns {Array<object|string>} Merged changed_files array
 */
function mergeChangedFilesWithDiff(changedFiles, diff) {
  const patchMap = parseUnifiedDiffPatches(diff);
  if (patchMap.size === 0) {
    return Array.isArray(changedFiles) ? changedFiles : [];
  }

  // Drop cached `git diff --stat` ellipsis stubs once we have authoritative
  // patch headers to recover the full file paths from.
  const existing = (Array.isArray(changedFiles) ? changedFiles : []).filter(entry => {
    const filePath = typeof entry === 'string' ? entry : entry?.file;
    return filePath && !filePath.includes('...');
  });

  const normalizedExisting = new Set(existing.map(file => {
    const filePath = typeof file === 'string' ? file : file?.file;
    return normalizePath(resolveRenamedFile(filePath));
  }).filter(Boolean));

  const merged = [...existing];

  for (const [filePath, patch] of patchMap.entries()) {
    const normalizedPatchPath = normalizePath(resolveRenamedFile(filePath));
    if (normalizedExisting.has(normalizedPatchPath)) {
      continue;
    }

    const { insertions, deletions } = countPatchStats(patch);
    const renameFrom = patch.match(/^rename from (.+)$/m)?.[1] || null;
    const renameTo = patch.match(/^rename to (.+)$/m)?.[1] || null;
    const binary = /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);

    merged.push({
      file: filePath,
      insertions,
      deletions,
      changes: insertions + deletions,
      binary,
      renamed: Boolean(renameFrom && renameTo),
      renamedFrom: renameFrom
    });
    normalizedExisting.add(normalizedPatchPath);
  }

  return merged;
}

/**
 * Return the list of file paths that belong to the review's diff.
 * Works for both PR-mode and local-mode reviews.
 *
 * @param {object} db   - SQLite database handle
 * @param {object} review - Review row from the database
 * @returns {Promise<string[]>} Array of relative file paths in the diff
 */
async function getDiffFileList(db, review) {
  // PR mode – pull from pr_metadata table
  if (review.pr_number && review.repository) {
    try {
      const prRecord = await queryOne(db, `
        SELECT pr_data FROM pr_metadata
        WHERE pr_number = ? AND repository = ? COLLATE NOCASE
      `, [review.pr_number, review.repository]);

      if (prRecord?.pr_data) {
        const prData = JSON.parse(prRecord.pr_data);
        return mergeChangedFilesWithDiff(prData.changed_files || [], prData.diff || '')
          .map(f => typeof f === 'string' ? f : f.file)
          .filter(Boolean);
      }
    } catch {
      // parse / query error – fall through to empty list
    }
    return [];
  }

  // Local mode – ask git for changed / untracked files
  if (review.local_path) {
    try {
      const opts = { cwd: review.local_path };
      const [{ stdout: unstaged }, { stdout: untracked }] = await Promise.all([
        execPromise(`git diff ${GIT_DIFF_FLAGS} --name-only`, opts),
        execPromise('git ls-files --others --exclude-standard', opts),
      ]);
      const combined = `${unstaged}\n${untracked}`
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      return [...new Set(combined)];
    } catch {
      // git error – fall through to empty list
    }
    return [];
  }

  return [];
}

module.exports = {
  getDiffFileList,
  parseUnifiedDiffPatches,
  countPatchStats,
  mergeChangedFilesWithDiff
};
