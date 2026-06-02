// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const crypto = require('crypto');

/**
 * @typedef {Object} Hunk
 * @property {string} header - Hunk header line, e.g. "@@ -10,5 +10,7 @@".
 * @property {string[]} lines - Diff lines including their leading marker
 *   ('+', '-', ' ', or the literal '\\ No newline at end of file' marker).
 */

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'Pipfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum'
]);

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const PYTHON_EXTENSIONS = new Set(['.py']);

const JS_IMPORT_PATTERN = /^(?:import\b|from\s+\S+\s+import\b|(?:const|let|var)\s+\w+\s*=\s*require\()/;
const PY_IMPORT_PATTERN = /^(?:import\b|from\s+\S+\s+import\b)/;
const PACKAGE_JSON_VERSION_PATTERN = /^"([^"]+)"\s*:\s*"[~^>=<]*\d[\w.\-+*]*"\,?\s*$/;

/**
 * SHA-256 hex of `${filePath}\n${hunkContent}`.
 * @param {string} filePath
 * @param {string} hunkContent
 * @returns {string}
 */
function hashHunk(filePath, hunkContent) {
  return crypto.createHash('sha256').update(`${filePath}\n${hunkContent}`).digest('hex');
}

function getExtension(filePath) {
  const slash = filePath.lastIndexOf('/');
  const base = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

function getBasename(filePath) {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

function classifyLines(lines) {
  const added = [];
  const removed = [];
  for (const line of lines) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

function isImportOnlyReorder(added, removed, ext) {
  let pattern;
  if (JS_TS_EXTENSIONS.has(ext)) pattern = JS_IMPORT_PATTERN;
  else if (PYTHON_EXTENSIONS.has(ext)) pattern = PY_IMPORT_PATTERN;
  else return false;

  if (added.length === 0 && removed.length === 0) return false;

  const addedTrimmed = added.map((l) => l.trim());
  const removedTrimmed = removed.map((l) => l.trim());

  for (const line of addedTrimmed) {
    if (!pattern.test(line)) return false;
  }
  for (const line of removedTrimmed) {
    if (!pattern.test(line)) return false;
  }

  if (addedTrimmed.length !== removedTrimmed.length) return false;
  const a = [...addedTrimmed].sort();
  const r = [...removedTrimmed].sort();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== r[i]) return false;
  }
  return true;
}

function extractPackageJsonVersionKey(line) {
  const match = PACKAGE_JSON_VERSION_PATTERN.exec(line);
  return match ? match[1] : null;
}

function isVersionBumpChange(added, removed, basename) {
  if (basename !== 'package.json' && !LOCKFILE_BASENAMES.has(basename)) return false;
  if (added.length === 0 && removed.length === 0) return false;

  if (LOCKFILE_BASENAMES.has(basename)) return true;

  const addedKeys = [];
  for (const line of added) {
    const key = extractPackageJsonVersionKey(line.trim());
    if (key === null) return false;
    addedKeys.push(key);
  }
  const removedKeys = [];
  for (const line of removed) {
    const key = extractPackageJsonVersionKey(line.trim());
    if (key === null) return false;
    removedKeys.push(key);
  }

  if (addedKeys.length !== removedKeys.length) return false;
  const a = [...addedKeys].sort();
  const r = [...removedKeys].sort();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== r[i]) return false;
  }
  return true;
}

/**
 * Classify a hunk as trivial under one of several heuristics.
 *
 * Callers that need generated-file detection should pass
 *   isGeneratedFile: parser.isGenerated.bind(parser)
 * where `parser` is the result of
 *   await getGeneratedFilePatterns(worktreePath)
 * from src/git/gitattributes.js. When `isGeneratedFile` is omitted, the
 * generated-file rule is skipped silently.
 * @param {Hunk} hunk
 * @param {string} filePath
 * @param {{ isGeneratedFile?: (filePath: string) => boolean }} [options]
 * @returns {{ trivial: boolean, reason?: 'imports'|'version_bump'|'generated' }}
 */
function isTrivialHunk(hunk, filePath, options) {
  const opts = options || {};

  if (typeof opts.isGeneratedFile === 'function' && opts.isGeneratedFile(filePath) === true) {
    return { trivial: true, reason: 'generated' };
  }

  const lines = hunk && Array.isArray(hunk.lines) ? hunk.lines : [];
  const { added, removed } = classifyLines(lines);

  const ext = getExtension(filePath);
  if (isImportOnlyReorder(added, removed, ext)) {
    return { trivial: true, reason: 'imports' };
  }

  const basename = getBasename(filePath);
  if (isVersionBumpChange(added, removed, basename)) {
    return { trivial: true, reason: 'version_bump' };
  }

  return { trivial: false };
}

module.exports = { hashHunk, isTrivialHunk };
