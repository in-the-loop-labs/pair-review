// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for resolving file content directly from a cached diff snapshot.
 *
 * The diff's `index <old>..<new>` line is more precise than a repo-wide
 * `base_sha` because it identifies the exact blob used for that file in the
 * rendered patch, even if cached PR metadata drifts.
 */

const { parseDiffGitPaths, parsePatchPaths } = require('./git-paths');

/**
 * Index the blob info of every file in a diff in a single pass.
 *
 * Each file is keyed by both its old and new path. When a path appears in
 * more than one file block, the first block wins. A block whose first
 * `index` line is malformed records `null` for its paths, and a block with
 * no `index` line (e.g. a pure rename) records nothing, so a later block may
 * still supply the path. This matches a per-file top-to-bottom scan.
 *
 * @param {string} diffText - Unified diff text
 * @returns {Map<string, Object|null>} path -> { oldPath, newPath, oldBlob, newBlob } or null
 */
function buildFileBlobIndex(diffText) {
  const index = new Map();
  if (!diffText) {
    return index;
  }

  const lines = diffText.split('\n');
  let blockPaths = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      blockPaths = parsePatchPaths(lines, i);
      continue;
    }

    if (!blockPaths || !line.startsWith('index ')) {
      continue;
    }

    const match = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: \d+)?$/i);
    const blobInfo = match
      ? { ...blockPaths, oldBlob: match[1], newBlob: match[2] }
      : null;

    for (const filePath of [blockPaths.oldPath, blockPaths.newPath]) {
      if (filePath && !index.has(filePath)) {
        index.set(filePath, blobInfo);
      }
    }

    // Only the first index line of a block describes it.
    blockPaths = null;
  }

  return index;
}

function findFileBlobInfoInDiff(diffText, fileName) {
  if (!diffText || !fileName) {
    return null;
  }

  return buildFileBlobIndex(diffText).get(fileName) ?? null;
}

function isZeroObjectId(objectId) {
  return typeof objectId === 'string' && /^0+$/.test(objectId);
}

/**
 * Build the ordered git specs for a file's original content: the exact diff
 * blob first, then the file at base_sha. Callers fall back to the worktree
 * when every spec fails or none apply.
 *
 * @param {Object|null} blobInfo - The file's entry from buildFileBlobIndex
 * @param {string|null} baseSha - The PR's base commit
 * @param {string} fileName - Path requested by the caller
 * @returns {Array<{gitSpec: string, source: string}>}
 */
function buildOriginalFileContentSpecs(blobInfo, baseSha, fileName) {
  const specs = [];

  if (blobInfo?.oldBlob && !isZeroObjectId(blobInfo.oldBlob)) {
    specs.push({
      gitSpec: blobInfo.oldBlob,
      source: 'diff blob'
    });
  }

  if (baseSha) {
    const originalPath = blobInfo?.oldPath || fileName;
    specs.push({
      gitSpec: `${baseSha}:${originalPath}`,
      source: 'base commit'
    });
  }

  return specs;
}

function resolveOriginalFileContentSpecs(prData, fileName) {
  if (!prData || typeof prData !== 'object') {
    return [];
  }

  const blobInfo = findFileBlobInfoInDiff(prData.diff, fileName);
  return buildOriginalFileContentSpecs(blobInfo, prData.base_sha, fileName);
}

function resolveOriginalFileContentSpec(prData, fileName) {
  return resolveOriginalFileContentSpecs(prData, fileName)[0] || null;
}

module.exports = {
  buildFileBlobIndex,
  buildOriginalFileContentSpecs,
  findFileBlobInfoInDiff,
  parseDiffGitPaths,
  resolveOriginalFileContentSpecs,
  resolveOriginalFileContentSpec
};
