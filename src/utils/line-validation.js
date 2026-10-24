// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// A NUL byte in the first 8 KB marks a file as binary (git's heuristic too).
const BINARY_SCAN_BYTES = 8192;

/**
 * Count lines the way editors number them: an empty file has 0 lines, "a" and
 * "a\n" have 1, "a\nb" has 2 (a trailing newline does not start a new line).
 * @param {string} content - File content
 * @returns {number} Line count
 */
function countLines(content) {
  if (content.length === 0) return 0;
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

/**
 * Count a file's lines, or return -1 for a binary file. Only the first
 * BINARY_SCAN_BYTES are read before the binary check, so a large binary asset
 * is rejected without loading it into memory.
 * @param {string} fullPath - Absolute file path
 * @returns {Promise<number>} Line count, or -1 when the file is binary
 * @throws When the file cannot be opened or read
 */
async function countFileLines(fullPath) {
  const handle = await fs.promises.open(fullPath, 'r');
  try {
    const head = Buffer.alloc(BINARY_SCAN_BYTES);
    let filled = 0;
    // position=null reads from (and advances) the handle's file position, so
    // readFile() below continues exactly where the scan stopped.
    while (filled < BINARY_SCAN_BYTES) {
      const { bytesRead } = await handle.read(head, filled, BINARY_SCAN_BYTES - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (head.subarray(0, filled).includes(0)) {
      return -1;
    }
    const rest = filled < BINARY_SCAN_BYTES ? Buffer.alloc(0) : await handle.readFile();
    // Decode the whole buffer at once so a multi-byte character spanning the
    // scan boundary is not split.
    return countLines(Buffer.concat([head.subarray(0, filled), rest]).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Build a map of file paths to their line counts
 * @param {string} worktreePath - Path to the git worktree
 * @param {Array<string>} validFiles - List of changed file paths
 * @returns {Promise<Map<string, number>>} Map of filePath -> lineCount
 */
async function buildFileLineCountMap(worktreePath, validFiles) {
  if (!validFiles || !Array.isArray(validFiles) || validFiles.length === 0) {
    return new Map();
  }

  // Read all files in parallel
  const results = await Promise.all(validFiles.map(async (filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }

    const fullPath = path.join(worktreePath, filePath);

    try {
      return { filePath, lineCount: await countFileLines(fullPath) };
    } catch (error) {
      // File doesn't exist or can't be read - mark as -1
      return { filePath, lineCount: -1 };
    }
  }));

  // Build the map from results
  const fileLineCountMap = new Map();
  for (const result of results) {
    if (result !== null) {
      fileLineCountMap.set(result.filePath, result.lineCount);
    }
  }

  return fileLineCountMap;
}

/**
 * Validate suggestion line numbers against file lengths
 * @param {Array} suggestions - Array of suggestion objects with file, line_start, line_end
 * @param {Map<string, number>} fileLineCountMap - Map of file paths to line counts
 * @param {Object} options - { convertToFileLevel: boolean }
 * @returns {Object} { valid: [], converted: [], dropped: [] }
 */
function validateSuggestionLineNumbers(suggestions, fileLineCountMap, options = {}) {
  const { convertToFileLevel = false } = options;
  const result = {
    valid: [],
    converted: [],
    dropped: []
  };

  if (!suggestions || !Array.isArray(suggestions)) {
    return result;
  }

  for (const suggestion of suggestions) {
    // File-level suggestions (line_start === null) always pass through
    if (suggestion.line_start === null || suggestion.line_start === undefined) {
      result.valid.push(suggestion);
      continue;
    }

    const filePath = suggestion.file;
    const lineCount = fileLineCountMap.get(filePath);

    // If file not in map, pass through (might be deleted file or file we couldn't process)
    if (lineCount === undefined) {
      result.valid.push(suggestion);
      continue;
    }

    // Binary files (lineCount === -1) - pass through since we can't validate line numbers
    if (lineCount === -1) {
      result.valid.push(suggestion);
      continue;
    }

    // Validate line numbers
    const lineStart = suggestion.line_start;
    const lineEnd = suggestion.line_end !== undefined && suggestion.line_end !== null
      ? suggestion.line_end
      : lineStart;

    let isValid = true;
    let reason = '';

    // Check line_start is valid
    if (lineStart <= 0) {
      isValid = false;
      reason = `line_start ${lineStart} is <= 0`;
    } else if (lineStart > lineCount) {
      isValid = false;
      reason = `line_start ${lineStart} exceeds file length ${lineCount}`;
    }

    // Check line_end is valid
    if (isValid && lineEnd < lineStart) {
      isValid = false;
      reason = `line_end ${lineEnd} is less than line_start ${lineStart}`;
    } else if (isValid && lineEnd > lineCount) {
      isValid = false;
      reason = `line_end ${lineEnd} exceeds file length ${lineCount}`;
    }

    if (isValid) {
      result.valid.push(suggestion);
    } else if (convertToFileLevel) {
      // Convert to file-level suggestion
      const convertedSuggestion = {
        ...suggestion,
        line_start: null,
        line_end: null,
        is_file_level: true
      };
      result.converted.push(convertedSuggestion);
      logger.warn(`[Line Validation] Converting suggestion to file-level: "${suggestion.title}" (${reason})`);
    } else {
      // Drop the suggestion
      result.dropped.push(suggestion);
      logger.warn(`[Line Validation] Dropping suggestion: "${suggestion.title}" (${reason})`);
    }
  }

  return result;
}

module.exports = { buildFileLineCountMap, validateSuggestionLineNumbers };
