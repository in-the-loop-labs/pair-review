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
 * Git config that makes path-producing commands print names verbatim.
 *
 * With git's default core.quotePath=true, any path with a byte >= 0x80 is
 * C-quoted with octal escapes (`"caf\303\251.js"`) in diff headers,
 * --name-only, --numstat and ls-files output. Pinning it off keeps non-ASCII
 * names readable everywhere. `-c` must precede the subcommand, so exec calls
 * spell commands as `git ${GIT_PATH_CONFIG} diff ...`.
 *
 * Git still quotes paths containing control characters, `"` or `\` in diff
 * headers; src/utils/git-paths.js decodes those. Path LISTS are read with -z,
 * which is never quoted.
 */
const GIT_PATH_CONFIG = '-c core.quotePath=false';

/**
 * Array form of GIT_PATH_CONFIG for execFile / spawn argument lists.
 */
const GIT_PATH_CONFIG_ARRAY = ['-c', 'core.quotePath=false'];

/**
 * simple-git constructor options carrying the same config, for every
 * simple-git instance that runs diff: `simpleGit(dir, SIMPLE_GIT_PATH_OPTIONS)`.
 */
const SIMPLE_GIT_PATH_OPTIONS = Object.freeze({ config: ['core.quotePath=false'] });

module.exports = {
  GIT_DIFF_FLAGS,
  GIT_DIFF_FLAGS_ARRAY,
  GIT_PATH_CONFIG,
  GIT_PATH_CONFIG_ARRAY,
  SIMPLE_GIT_PATH_OPTIONS
};
