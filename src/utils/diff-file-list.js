// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { queryOne } = require('../database');
const { listScopedChangedFiles } = require('../git/scoped-changed-files');
const { reviewScope } = require('../local-scope');
const { normalizePath, resolveRenamedFile } = require('./paths');
const { parseHunkHeader } = require('./diff-annotator');
const { decodeGitPath, parsePatchPaths } = require('./git-paths');

/**
 * Split a unified diff into its per-file patches, in order, keyed by the
 * decoded new path: the `rename to` / `copy to` line when there is one,
 * otherwise the `diff --git` header's "b/" side (see parsePatchPaths in
 * public/js/utils/git-paths.js).
 *
 * A path can appear more than once: git prints a file <-> symlink type change
 * as a deletion block followed by an addition block for the same path. Every
 * block is kept, so callers that need the whole change can combine them.
 *
 * @param {string} diff - Full unified diff
 * @returns {Array<[string, string]>} [file path, per-file patch] pairs
 */
function splitUnifiedDiffPatches(diff) {
  const patches = [];
  if (!diff) return patches;

  for (const part of diff.split(/(?=^diff --git )/m)) {
    if (!part.trim()) continue;

    const paths = parsePatchPaths(part);
    if (paths) {
      patches.push([paths.newPath, part]);
    }
  }

  return patches;
}

/**
 * Parse a unified diff into a map of file path -> per-file patch, keyed like
 * splitUnifiedDiffPatches. When a path has more than one block (a type
 * change), the map holds the last one, matching the browser's
 * parseUnifiedDiff.
 *
 * @param {string} diff - Full unified diff
 * @returns {Map<string, string>} Map of file paths to full patch text
 */
function parseUnifiedDiffPatches(diff) {
  return new Map(splitUnifiedDiffPatches(diff));
}

/**
 * The extended header of a per-file patch: everything before the first `@@`
 * hunk header, where git prints the rename and binary markers.
 *
 * @param {string} patch - Per-file patch text
 * @returns {string} Header text (the whole patch when it has no hunk)
 */
function patchHeader(patch) {
  const hunkStart = patch.search(/^@@/m);
  return hunkStart === -1 ? patch : patch.slice(0, hunkStart);
}

/**
 * Count additions and deletions inside a single patch body.
 *
 * Only lines inside a hunk count: after an `@@` header and within the line
 * counts it declares. A prefix test cannot tell headers from content — a
 * deleted `-- x` line is emitted as `--- x` and an added `++ x` as `+++ x` —
 * but hunk state can: `---`/`+++` are headers only outside a hunk (the same
 * rule `buildDiffLineSet` in diff-annotator.js follows). Mirrored in the
 * browser by `HunkParser.countPatchStats`; both suites share
 * tests/utils/diff-stat-fixtures.js.
 *
 * @param {string} patch - Per-file patch text
 * @returns {{ insertions: number, deletions: number }}
 */
function countPatchStats(patch) {
  let insertions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of (patch || '').split('\n')) {
    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldRemaining = hunk.oldCount;
      newRemaining = hunk.newCount;
    } else if (line.startsWith('+') && newRemaining > 0) {
      insertions++;
      newRemaining--;
    } else if (line.startsWith('-') && oldRemaining > 0) {
      deletions++;
      oldRemaining--;
    } else if (line.startsWith(' ')) {
      oldRemaining--;
      newRemaining--;
    }
  }

  return { insertions, deletions };
}

/**
 * Describe one file of a unified diff as a `changed_files` entry.
 *
 * Renames come from the explicit `rename from` / `rename to` lines, so a
 * rename is recorded whatever the two paths have in common, and a file
 * literally named `a => b.md` is never mistaken for one.
 *
 * @param {string} filePath - Decoded new path (the parseUnifiedDiffPatches key)
 * @param {string} patch - Per-file patch text
 * @returns {{ file: string, insertions: number, deletions: number, changes: number,
 *   binary: boolean, renamed?: true, renamedFrom?: string }}
 */
function buildChangedFileEntry(filePath, patch) {
  const { insertions, deletions } = countPatchStats(patch);
  const header = patchHeader(patch);
  const entry = {
    file: filePath,
    insertions,
    deletions,
    changes: insertions + deletions,
    binary: /^Binary files .* differ$/m.test(header) || /^GIT binary patch$/m.test(header)
  };
  if (/^rename from /m.test(header) && /^rename to /m.test(header)) {
    entry.renamed = true;
    entry.renamedFrom = parsePatchPaths(patch).oldPath;
  }
  return entry;
}

/**
 * Describe every file of a unified diff as a `changed_files` entry, one per
 * path. A path with more than one block (git prints a file <-> symlink type
 * change as a deletion followed by an addition) gets one entry whose counts
 * are the sum of its blocks, so it reads +1/-1 like `--numstat`, not as a
 * new file.
 *
 * @param {Array<[string, string]>} patches - From splitUnifiedDiffPatches
 * @returns {Map<string, object>} File path -> entry, in diff order
 */
function buildMergedChangedFileEntries(patches) {
  const entries = new Map();
  for (const [filePath, patch] of patches) {
    const entry = buildChangedFileEntry(filePath, patch);
    const previous = entries.get(filePath);
    if (!previous) {
      entries.set(filePath, entry);
      continue;
    }
    previous.insertions += entry.insertions;
    previous.deletions += entry.deletions;
    previous.changes += entry.changes;
    previous.binary = previous.binary || entry.binary;
    if (entry.renamed && !previous.renamed) {
      previous.renamed = true;
      previous.renamedFrom = entry.renamedFrom;
    }
  }
  return entries;
}

/**
 * Build PR `changed_files` from the unified diff: one entry per file, with
 * path, rename, additions/deletions and binary flag read from the diff text
 * and `generated` from .gitattributes.
 *
 * This is the only producer of PR changed_files, so every PR path (setup,
 * refresh, headless, `?w=1`) spells each file exactly as the diff headers do.
 *
 * @param {string} diff - Full unified diff
 * @param {{ isGenerated: (file: string) => boolean }|null} [gitattributes] - Generated-file matcher
 * @returns {Array<object>} changed_files entries
 */
function buildChangedFileEntries(diff, gitattributes = null) {
  return [...buildMergedChangedFileEntries(splitUnifiedDiffPatches(diff)).values()].map(entry => ({
    ...entry,
    generated: gitattributes ? gitattributes.isGenerated(entry.file) : false
  }));
}

/**
 * Re-spell a changed_files entry cached by a version that read paths from
 * git's default C-quoted output (`"caf\303\251.js"`), so it matches the
 * decoded diff headers until the review is refreshed. The decoded spelling is
 * adopted only when the diff confirms it, so a real name that merely looks
 * quoted is never mangled.
 *
 * @param {object|string} entry - changed_files entry
 * @param {Map<string, string>} patchMap - From parseUnifiedDiffPatches
 * @returns {object|string} Entry spelled like the diff headers
 */
function respellCachedEntry(entry, patchMap) {
  const filePath = typeof entry === 'string' ? entry : entry.file;
  if (patchMap.has(filePath)) return entry;
  const decoded = decodeGitPath(filePath);
  if (decoded === filePath || !patchMap.has(decoded)) return entry;
  return typeof entry === 'string' ? decoded : { ...entry, file: decoded };
}

/**
 * Merge changed_files metadata with the authoritative file list from the diff.
 * This recovers files when cached changed_files were derived from abbreviated
 * diff --stat output and no longer match the full patch headers, and
 * re-spells entries cached in git's quoted form so they match the decoded
 * diff headers until the review is refreshed.
 *
 * @param {Array<object|string>} changedFiles - Existing changed_files array
 * @param {string} diff - Full unified diff
 * @returns {Array<object|string>} Merged changed_files array
 */
function mergeChangedFilesWithDiff(changedFiles, diff) {
  const patches = splitUnifiedDiffPatches(diff);
  const patchMap = new Map(patches);
  if (patchMap.size === 0) {
    return Array.isArray(changedFiles) ? changedFiles : [];
  }

  // Drop cached `git diff --stat` ellipsis stubs once we have authoritative
  // patch headers to recover the full file paths from.
  const existing = (Array.isArray(changedFiles) ? changedFiles : []).filter(entry => {
    const filePath = typeof entry === 'string' ? entry : entry?.file;
    return filePath && !filePath.includes('...');
  }).map(entry => respellCachedEntry(entry, patchMap));

  const normalizedExisting = new Set(existing.map(file => {
    const filePath = typeof file === 'string' ? file : file?.file;
    return normalizePath(resolveRenamedFile(filePath));
  }).filter(Boolean));

  const merged = [...existing];

  for (const [filePath, entry] of buildMergedChangedFileEntries(patches)) {
    const normalizedPatchPath = normalizePath(resolveRenamedFile(filePath));
    if (normalizedExisting.has(normalizedPatchPath)) {
      continue;
    }

    merged.push(entry);
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

  // Local mode – ask git for the files within the review's selected scope
  // (staged and branch changes included when selected).
  if (review.local_path) {
    try {
      const { start, end } = reviewScope(review);
      return await listScopedChangedFiles(review.local_path, {
        scopeStart: start, scopeEnd: end, baseBranch: review.local_base_branch
      });
    } catch {
      // git error – fall through to empty list
    }
    return [];
  }

  return [];
}

/**
 * Return the file paths of the diff the review currently displays.
 *
 * Local reviews read the persisted diff snapshot (`local_diffs`), which is
 * what the browser renders; without a snapshot they fall back to listing the
 * review's scope from git. PR reviews use the cached PR metadata.
 *
 * @param {object} db - SQLite database handle
 * @param {object} review - Review row from the database
 * @returns {Promise<string[]>} Relative file paths in the diff
 */
async function getReviewDiffFiles(db, review) {
  if (!review) return [];
  if (review.local_path) {
    const snapshot = await queryOne(db, 'SELECT diff_text FROM local_diffs WHERE review_id = ?', [review.id]);
    if (snapshot) {
      return [...parseUnifiedDiffPatches(snapshot.diff_text).keys()];
    }
  }
  return getDiffFileList(db, review);
}

module.exports = {
  getDiffFileList,
  getReviewDiffFiles,
  splitUnifiedDiffPatches,
  parseUnifiedDiffPatches,
  countPatchStats,
  buildChangedFileEntries,
  mergeChangedFilesWithDiff
};
