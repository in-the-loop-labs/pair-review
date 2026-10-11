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
  findFileBlobInfoInDiff,
  parseDiffGitPaths,
  resolveOriginalFileContentSpecs,
  resolveOriginalFileContentSpec
};
