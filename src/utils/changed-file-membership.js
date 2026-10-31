// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The one "is this file part of the review's diff?" check.
 *
 * Suggestion validation, context-file seeding, comment auto-context and
 * GitHub submission all ask the same question, so they share this predicate.
 * An exact match wins; otherwise both sides are compared through
 * `normalizePath` (so `./a.js` and `a.js` agree), and the entry's own path
 * is returned either way. Nothing else is rewritten: a path containing
 * ` => ` or `{a => b}` is a literal file name here, never Git rename syntax. A real file named
 * `a => b.md` therefore matches only the changed-file entry `a => b.md`.
 */
const { normalizePath } = require('./paths');
const { mergeChangedFilesWithDiff } = require('./diff-file-list');

/**
 * Path of a changed_files entry: a plain string, a git numstat entry
 * (`file`) or a GitHub API entry (`filename`).
 * @param {object|string} entry
 * @returns {string|null}
 */
function changedFileEntryPath(entry) {
  if (typeof entry === 'string') return entry;
  const filePath = entry?.file ?? entry?.filename ?? entry?.path;
  return typeof filePath === 'string' ? filePath : null;
}

/**
 * Build a resolver that maps a file path to its changed-file entry.
 *
 * @param {Array<object|string>|null} changedFiles - changed_files entries or paths
 * @param {string} [diff] - Full unified diff; recovers entries missing from changedFiles
 * @returns {((file: string) => string|null) & { hasChangedFiles: boolean }}
 *   Returns the canonical changed_files entry path for a changed file, or null.
 *   `hasChangedFiles` is false when the list is empty, meaning membership is
 *   unknown rather than "nothing changed".
 */
function createChangedFilePredicate(changedFiles, diff = '') {
  const entries = diff
    ? mergeChangedFilesWithDiff(changedFiles, diff)
    : (Array.isArray(changedFiles) ? changedFiles : []);

  // Entry paths are git's own spelling. An exact match returns that entry;
  // otherwise both sides are normalized (a stray leading "./" or doubled
  // slash) to find it. Either way the entry's own path comes back, never the
  // normalized lookup key: normalizing also trims whitespace, and a file
  // named "notes.md " (git allows it) must keep its trailing space.
  const entryPaths = new Set();
  const byKey = new Map();
  for (const entry of entries) {
    const entryPath = changedFileEntryPath(entry);
    if (!entryPath) continue;
    entryPaths.add(entryPath);
    const key = normalizePath(entryPath);
    if (key && !byKey.has(key)) byKey.set(key, entryPath);
  }

  const resolve = file => {
    if (typeof file !== 'string' || !file) return null;
    if (entryPaths.has(file)) return file;
    const key = normalizePath(file);
    return (key && byKey.get(key)) || null;
  };
  resolve.hasChangedFiles = entryPaths.size > 0;
  return resolve;
}

/**
 * Split items (comments or findings with a `file` field) into those on a
 * changed file and those on files outside the diff. Items on a changed file
 * come back spelled like their changed-file entry.
 *
 * When the changed-file list is unknown (empty, and the diff recovers nothing),
 * no item is treated as outside the diff: every item is kept with its own
 * path. This matches analysis-side validation (partitionSuggestionPaths).
 *
 * @param {Array<Object>|null} items - Items with a `file` field
 * @param {Array<object|string>|null} changedFiles - changed_files entries or paths
 * @param {string} [diff] - Full unified diff; recovers entries missing from changedFiles
 * @returns {{inDiff: Array<Object>, outsideDiff: Array<Object>, membershipKnown: boolean}}
 */
function partitionByChangedFile(items, changedFiles, diff = '') {
  const list = items || [];
  const resolveChangedFile = createChangedFilePredicate(changedFiles, diff);
  if (!resolveChangedFile.hasChangedFiles) {
    return { inDiff: [...list], outsideDiff: [], membershipKnown: false };
  }

  const inDiff = [];
  const outsideDiff = [];
  for (const item of list) {
    const file = resolveChangedFile(item?.file);
    if (!file) {
      outsideDiff.push(item);
    } else {
      inDiff.push(file === item.file ? item : { ...item, file });
    }
  }
  return { inDiff, outsideDiff, membershipKnown: true };
}

module.exports = { createChangedFilePredicate, changedFileEntryPath, partitionByChangedFile };
