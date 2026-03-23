// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { execSync } = require('child_process');

const DEFAULT_SHA_ABBREV_LENGTH = 7;

const defaults = {
  execSync,
};

/**
 * Get the SHA abbreviation length that Git uses for a given repository.
 *
 * Calls `git rev-parse --short HEAD` and measures the output length.
 * This respects the repository's `core.abbrev` setting and Git's
 * auto-scaling logic (larger repos get longer abbreviations).
 *
 * @param {string} repoPath - Absolute path to the repository
 * @param {Object} [_deps] - Dependency overrides for testing
 * @returns {number} The abbreviation length Git uses for this repo
 */
function getShaAbbrevLength(repoPath, _deps) {
  const deps = { ...defaults, ..._deps };
  try {
    const shortSha = deps.execSync('git rev-parse --short HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return shortSha.length || DEFAULT_SHA_ABBREV_LENGTH;
  } catch {
    return DEFAULT_SHA_ABBREV_LENGTH;
  }
}

module.exports = { getShaAbbrevLength, DEFAULT_SHA_ABBREV_LENGTH };
