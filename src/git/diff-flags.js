// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Shared git diff flags used across all diff operations.
 *
 * Rationale for each flag:
 * - --no-color: Disable color output for consistent parsing (overrides color.diff / color.ui)
 * - --no-ext-diff: Disable external diff drivers (overrides diff.external)
 * - --src-prefix=a/ --dst-prefix=b/: Ensure consistent a/ b/ prefixes (overrides diff.noprefix / diff.mnemonicPrefix)
 * - --no-relative: Ensure paths are repo-root-relative (overrides diff.relative)
 * - --full-index: Persist full blob IDs so diff snapshots remain durable over time
 */

/**
 * String form for execSync / exec shell calls (e.g. `git diff ${GIT_DIFF_FLAGS} ...`).
 */
const GIT_DIFF_FLAGS = '--no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ --no-relative --full-index';

/**
 * Array form for simple-git .diff() calls (full diff output including file content).
 */
const GIT_DIFF_FLAGS_ARRAY = [
  '--no-color',
  '--no-ext-diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-relative',
  '--full-index'
];

/**
 * Array form for simple-git .diffSummary() calls.
 * Use --numstat so simple-git parses machine-readable output with exact file paths.
 * The default --stat output is display-oriented and may abbreviate long paths,
 * which breaks downstream matching for generated route files and similar cases.
 * Omits --src-prefix/--dst-prefix since diffSummary doesn't output file content with prefixes.
 */
const GIT_DIFF_SUMMARY_FLAGS_ARRAY = [
  '--no-color',
  '--no-ext-diff',
  '--no-relative',
  '--numstat'
];

module.exports = {
  GIT_DIFF_FLAGS,
  GIT_DIFF_FLAGS_ARRAY,
  GIT_DIFF_SUMMARY_FLAGS_ARRAY
};
