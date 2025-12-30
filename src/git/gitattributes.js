const fs = require('fs').promises;
const path = require('path');

/**
 * GitAttributes parser for detecting linguist-generated files
 *
 * Parses .gitattributes files to identify files marked with:
 * - linguist-generated=true
 * - linguist-generated (without value, defaults to true)
 */
class GitAttributesParser {
  constructor() {
    this.generatedPatterns = [];
  }

  /**
   * Parse .gitattributes file from the worktree root
   * @param {string} worktreePath - Path to the git worktree
   * @returns {Promise<GitAttributesParser>} Returns self for chaining
   */
  async parse(worktreePath) {
    this.generatedPatterns = [];

    const gitattributesPath = path.join(worktreePath, '.gitattributes');

    try {
      const content = await fs.readFile(gitattributesPath, 'utf8');
      this.parseContent(content);
    } catch (error) {
      // .gitattributes doesn't exist or can't be read - this is fine
      if (error.code !== 'ENOENT') {
        console.warn(`Warning: Could not read .gitattributes: ${error.message}`);
      }
    }

    return this;
  }

  /**
   * Parse .gitattributes content
   * @param {string} content - Content of .gitattributes file
   */
  parseContent(content) {
    const lines = content.split('\n');

    for (const line of lines) {
      // Skip empty lines and comments
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Check for linguist-generated attribute
      // Formats:
      // - pattern linguist-generated=true
      // - pattern linguist-generated
      // - pattern attr1 linguist-generated=true attr2
      if (trimmed.includes('linguist-generated')) {
        // Split on whitespace to get pattern and attributes
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const pattern = parts[0];
          const attrs = parts.slice(1);

          // Check if linguist-generated is set to true (or just present, which defaults to true)
          const isGenerated = attrs.some(attr => {
            if (attr === 'linguist-generated') return true;
            if (attr === 'linguist-generated=true') return true;
            if (attr === '-linguist-generated') return false; // Negation
            if (attr === 'linguist-generated=false') return false;
            return false;
          });

          if (isGenerated) {
            this.generatedPatterns.push(pattern);
          }
        }
      }
    }
  }

  /**
   * Check if a file matches any of the generated patterns
   * @param {string} filePath - Relative file path to check
   * @returns {boolean} True if the file is marked as generated
   */
  isGenerated(filePath) {
    if (this.generatedPatterns.length === 0) {
      return false;
    }

    for (const pattern of this.generatedPatterns) {
      if (this.matchPattern(pattern, filePath)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Match a gitattributes pattern against a file path
   * Supports:
   * - Exact matches (package-lock.json)
   * - Wildcards (*.min.js)
   * - Double wildcards (**\/*.generated.js)
   * - Directory matches (vendor/)
   *
   * @param {string} pattern - The gitattributes pattern
   * @param {string} filePath - The file path to test
   * @returns {boolean} True if the pattern matches
   */
  matchPattern(pattern, filePath) {
    // Normalize paths to use forward slashes
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Handle directory patterns (ending with /)
    if (normalizedPattern.endsWith('/')) {
      const dirPattern = normalizedPattern.slice(0, -1);
      return normalizedPath.startsWith(dirPattern + '/');
    }

    // Convert gitattributes pattern to regex
    const regex = this.patternToRegex(normalizedPattern);
    return regex.test(normalizedPath);
  }

  /**
   * Convert a gitattributes glob pattern to a regular expression
   * @param {string} pattern - The glob pattern
   * @returns {RegExp} Regular expression for matching
   */
  patternToRegex(pattern) {
    // Escape regex special characters except * and ?
    let regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Replace ** with a placeholder
      .replace(/\*\*/g, '\x00')
      // Replace * (not preceded by *) with match any within path segment
      .replace(/\*/g, '[^/]*')
      // Replace placeholder with match any including path separators
      .replace(/\x00/g, '.*')
      // Replace ? with match single character
      .replace(/\?/g, '[^/]');

    // If pattern doesn't contain a slash, it can match at any directory level
    // e.g., "*.min.js" should match "foo/bar/file.min.js"
    if (!pattern.includes('/')) {
      regexStr = '(^|.*/)'+ regexStr + '$';
    } else if (pattern.startsWith('/')) {
      // Pattern starting with / matches from root only
      regexStr = '^' + regexStr.slice(1) + '$';
    } else {
      // Pattern with slashes must match the exact path structure
      regexStr = '(^|.*/)'+ regexStr + '$';
    }

    return new RegExp(regexStr);
  }

  /**
   * Get the list of generated file patterns
   * @returns {Array<string>} Array of patterns
   */
  getPatterns() {
    return [...this.generatedPatterns];
  }
}

/**
 * Get generated file patterns from a worktree
 * @param {string} worktreePath - Path to the git worktree
 * @returns {Promise<GitAttributesParser>} Parser instance with loaded patterns
 */
async function getGeneratedFilePatterns(worktreePath) {
  const parser = new GitAttributesParser();
  await parser.parse(worktreePath);
  return parser;
}

/**
 * Check if any of the given files are generated
 * @param {string} worktreePath - Path to the git worktree
 * @param {Array<Object>} files - Array of file objects with 'file' property
 * @returns {Promise<Set<string>>} Set of generated file paths
 */
async function getGeneratedFiles(worktreePath, files) {
  const parser = await getGeneratedFilePatterns(worktreePath);
  const generatedFiles = new Set();

  for (const fileObj of files) {
    const filePath = typeof fileObj === 'string' ? fileObj : fileObj.file;
    if (parser.isGenerated(filePath)) {
      generatedFiles.add(filePath);
    }
  }

  return generatedFiles;
}

module.exports = {
  GitAttributesParser,
  getGeneratedFilePatterns,
  getGeneratedFiles
};
