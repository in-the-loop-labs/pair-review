// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

/**
 * Check if a file is binary using the `file` command
 * @param {string} fullPath - Full path to the file
 * @returns {boolean} True if file is binary
 */
function isBinaryFile(fullPath) {
  try {
    // First check if file is empty - empty files are reported as "binary" by the file command
    // but we want to treat them as text files (with 0 lines)
    const stats = fs.statSync(fullPath);
    if (stats.size === 0) {
      return false;
    }

    // Use 'file --mime-encoding' to detect encoding
    // Binary files will show "binary" in the output
    const result = execSync(`file --mime-encoding "${fullPath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr
    });
    return result.includes('binary');
  } catch {
    // If command fails, fall back to assuming not binary
    return false;
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
      // Skip binary files - can't meaningfully count their "lines"
      if (isBinaryFile(fullPath)) {
        return { filePath, lineCount: -1 };
      }

      const content = await fs.promises.readFile(fullPath, 'utf-8');
      // Count lines by splitting on newlines
      // Empty file has 0 lines, file with "a" has 1 line, file with "a\n" has 1 line,
      // file with "a\nb" has 2 lines
      let lineCount;
      if (content.length === 0) {
        // Empty file has 0 lines
        lineCount = 0;
      } else {
        const lines = content.split('\n');
        // If file ends with newline, last element is empty string - don't count it as a line
        lineCount = content.endsWith('\n') && lines.length > 0
          ? lines.length - 1
          : lines.length;
      }

      return { filePath, lineCount };
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
