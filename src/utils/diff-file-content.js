// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for resolving file content directly from a cached diff snapshot.
 *
 * The diff's `index <old>..<new>` line is more precise than a repo-wide
 * `base_sha` because it identifies the exact blob used for that file in the
 * rendered patch, even if cached PR metadata drifts.
 */

const { parseDiffGitPaths, parsePatchPaths } = require('./git-paths');

function findFileBlobInfoInDiff(diffText, fileName) {
  if (!diffText || !fileName) {
    return null;
  }

  const lines = diffText.split('\n');
  let matchedPaths = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const paths = parsePatchPaths(lines, i);
      matchedPaths = paths && (paths.oldPath === fileName || paths.newPath === fileName)
        ? paths
        : null;
      continue;
    }

    if (!matchedPaths || !line.startsWith('index ')) {
      continue;
    }

    const match = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: \d+)?$/i);
    if (!match) {
      return null;
    }

    return {
      ...matchedPaths,
      oldBlob: match[1],
      newBlob: match[2]
    };
  }

  return null;
}

/**
 * Whether a unified diff has a file section for `fileName`, as either its
 * old or its new path. Paths are decoded the way every diff reader decodes
 * them (parsePatchPaths): C-quoted and octal-escaped headers name their real
 * file, and a rename's `rename from` / `rename to` lines settle a header that
 * is ambiguous on its own (`diff --git a/x b/y.js b/z.js`).
 * @param {string} diffText - Unified diff
 * @param {string} fileName - Repository-relative path
 * @returns {boolean}
 */
function diffContainsPath(diffText, fileName) {
  if (!diffText || !fileName) return false;
  const lines = diffText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('diff --git ')) continue;
    const paths = parsePatchPaths(lines, i);
    if (paths && (paths.oldPath === fileName || paths.newPath === fileName)) return true;
  }
  return false;
}

function isZeroObjectId(objectId) {
  return typeof objectId === 'string' && /^0+$/.test(objectId);
}

function resolveOriginalFileContentSpecs(prData, fileName) {
  if (!prData || typeof prData !== 'object') {
    return [];
  }

  const blobInfo = findFileBlobInfoInDiff(prData.diff, fileName);
  const specs = [];

  if (blobInfo?.oldBlob && !isZeroObjectId(blobInfo.oldBlob)) {
    specs.push({
      gitSpec: blobInfo.oldBlob,
      source: 'diff blob'
    });
  }

  if (prData.base_sha) {
    const originalPath = blobInfo?.oldPath || fileName;
    specs.push({
      gitSpec: `${prData.base_sha}:${originalPath}`,
      source: 'base commit'
    });
  }

  return specs;
}

function resolveOriginalFileContentSpec(prData, fileName) {
  return resolveOriginalFileContentSpecs(prData, fileName)[0] || null;
}

module.exports = {
  diffContainsPath,
  findFileBlobInfoInDiff,
  parseDiffGitPaths,
  resolveOriginalFileContentSpecs,
  resolveOriginalFileContentSpec
};
