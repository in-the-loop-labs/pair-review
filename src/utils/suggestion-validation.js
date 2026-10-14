// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Validation for AI suggestions before they are stored.
 *
 * Every writer of AI suggestions goes through these two functions: the three
 * analyzer paths (via Analyzer.validateSuggestionFilePaths /
 * validateAndFinalizeSuggestions / storeSuggestions), executable-provider
 * analysis and the external results import.
 *
 * A suggestion may target:
 *   - a changed file: kept as-is, with its path spelled like the changed-file
 *     entry it matches;
 *   - an unchanged file that exists inside the checkout the AI read: kept,
 *     forced to the NEW side (an unchanged file has only one version, and its
 *     line numbers are plain file lines), with line numbers checked against
 *     that file in the checkout;
 *   - anything else (missing files, directories, paths escaping the checkout,
 *     also through a symlink): discarded.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { normalizePath } = require('./paths');
const { isSafeRelativePath } = require('./review-paths');
const { createChangedFilePredicate } = require('./changed-file-membership');
const { buildFileLineCountMap, validateSuggestionLineNumbers } = require('./line-validation');

const defaults = { fs };

/**
 * Resolve a suggestion path to a regular file inside the checkout.
 * Both sides go through realpath, so a symlink pointing outside the checkout
 * is rejected even when its own path looks contained.
 *
 * @param {string} repoRoot - Checkout root
 * @param {string} file - Suggestion path
 * @param {Object} deps - { fs }
 * @returns {string|null} The normalized relative path, or null
 */
function resolveCheckoutFile(repoRoot, file, deps) {
  if (!repoRoot || !isSafeRelativePath(file)) return null;
  const relative = normalizePath(file);
  try {
    const root = deps.fs.realpathSync(repoRoot);
    const resolved = deps.fs.realpathSync(path.resolve(root, relative));
    if (!resolved.startsWith(root + path.sep)) return null;
    return deps.fs.statSync(resolved).isFile() ? relative : null;
  } catch {
    // Missing files, directories and inaccessible paths cannot anchor feedback.
    return null;
  }
}

/**
 * Split suggestions into those whose file is changed or is an existing file
 * in the checkout (kept) and the rest (discarded).
 *
 * When the changed-file list is empty, membership is unknown (e.g. a metadata
 * lookup failed), so every suggestion is kept unchanged and `bypassed` is set.
 *
 * @param {Array<Object>} suggestions - Suggestions with a `file` field
 * @param {Array<object|string>} changedFiles - The review's changed files
 * @param {string|null} repoRoot - Checkout the AI read; without one, findings
 *   on unchanged files cannot be verified and are discarded
 * @param {Object} [_deps] - Dependency overrides ({ fs })
 * @returns {{kept: Array<Object>, discarded: Array<Object>, bypassed: boolean}}
 *   Kept suggestions are new objects where a field changed.
 */
function partitionSuggestionPaths(suggestions, changedFiles, repoRoot, _deps) {
  const deps = { ...defaults, ..._deps };
  const list = suggestions || [];
  const resolveChanged = createChangedFilePredicate(changedFiles);
  if (!resolveChanged.hasChangedFiles) {
    return { kept: list, discarded: [], bypassed: true };
  }

  const checkoutFiles = new Map();
  const kept = [];
  const discarded = [];
  for (const suggestion of list) {
    const changedPath = resolveChanged(suggestion?.file);
    if (changedPath) {
      kept.push(changedPath === suggestion.file ? suggestion : { ...suggestion, file: changedPath });
      continue;
    }

    const file = suggestion?.file;
    if (!checkoutFiles.has(file)) {
      checkoutFiles.set(file, resolveCheckoutFile(repoRoot, file, deps));
    }
    const checkoutPath = checkoutFiles.get(file);
    if (checkoutPath) {
      kept.push({ ...suggestion, file: checkoutPath, old_or_new: 'NEW' });
    } else {
      discarded.push(suggestion);
    }
  }
  return { kept, discarded, bypassed: false };
}

/**
 * Keep suggestions whose file is changed, or is an existing file in the
 * checkout, logging the ones discarded. See partitionSuggestionPaths.
 *
 * @param {Array<Object>} suggestions - Suggestions with a `file` field
 * @param {Array<object|string>} changedFiles - The review's changed files
 * @param {string|null} repoRoot - Checkout the AI read
 * @param {Object} [_deps] - Dependency overrides ({ fs })
 * @returns {Array<Object>} Kept suggestions
 */
function filterSuggestionPaths(suggestions, changedFiles, repoRoot, _deps) {
  if (!suggestions || suggestions.length === 0) return [];
  const { kept, discarded, bypassed } = partitionSuggestionPaths(suggestions, changedFiles, repoRoot, _deps);
  if (bypassed) {
    logger.warn('[Validation] No valid paths provided for validation, skipping path filtering');
  }
  if (discarded.length > 0) {
    logger.warn(`[Validation] Discarded ${discarded.length} suggestion(s) with invalid file paths:`);
    for (const suggestion of discarded) {
      logger.warn(`  - "${suggestion?.file}": ${suggestion?.type} - ${suggestion?.title}`);
    }
  }
  return kept;
}

/**
 * Validate suggestion paths, then line numbers.
 *
 * Line numbers of changed files are checked against `fileLineCountMap`
 * (built by the caller for the changed files). Line numbers of unchanged
 * files are checked against the same file in the checkout. Invalid line
 * numbers convert the suggestion to file-level.
 *
 * @param {Array<Object>} suggestions - Suggestions to validate
 * @param {Object} options
 * @param {Array<object|string>} options.changedFiles - The review's changed files
 * @param {Map<string, number>} [options.fileLineCountMap] - Line counts of changed files
 * @param {string|null} [options.repoRoot] - Checkout the AI read
 * @param {Object} [_deps] - Dependency overrides ({ fs })
 * @returns {Promise<Array<Object>>} Valid suggestions followed by converted ones
 */
async function finalizeSuggestions(suggestions, { changedFiles, fileLineCountMap = new Map(), repoRoot = null } = {}, _deps) {
  const inputCount = suggestions?.length || 0;
  // Imported suggestions may carry a single `line`; validate it as a range.
  const normalized = (suggestions || []).map(suggestion =>
    suggestion && suggestion.line !== undefined && suggestion.line_start === undefined
      ? { ...suggestion, line_start: suggestion.line, line_end: suggestion.line_end ?? suggestion.line }
      : suggestion
  );

  const kept = filterSuggestionPaths(normalized, changedFiles, repoRoot, _deps);
  if (kept.length < inputCount) {
    logger.info(`[Validation] After file path validation: ${kept.length} suggestions (${inputCount - kept.length} filtered)`);
  }

  // Count lines of kept unchanged files in the checkout. Changed files keep
  // the caller's counts. With unknown membership nothing is known to be
  // unchanged, so nothing is counted here.
  const counts = new Map(fileLineCountMap);
  const resolveChanged = createChangedFilePredicate(changedFiles);
  if (repoRoot && resolveChanged.hasChangedFiles) {
    const unchanged = [...new Set(kept.map(s => s.file))]
      .filter(file => file && !counts.has(file) && !resolveChanged(file));
    if (unchanged.length > 0) {
      for (const [file, count] of await buildFileLineCountMap(repoRoot, unchanged)) {
        counts.set(file, count);
      }
    }
  }

  const lineResult = validateSuggestionLineNumbers(kept, counts, { convertToFileLevel: true });
  if (lineResult.converted.length > 0) {
    logger.warn(`[Line Validation] Converted ${lineResult.converted.length} suggestions to file-level due to invalid line numbers`);
  }
  return [...lineResult.valid, ...lineResult.converted];
}

module.exports = { partitionSuggestionPaths, filterSuggestionPaths, finalizeSuggestions };
