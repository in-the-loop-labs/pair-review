const path = require('path');

/**
 * PathContext manages path translations between different contexts:
 * - Display paths (relative to working directory for UI)
 * - GitHub paths (relative to repository root for API)
 * - Analysis paths (working directory for AI)
 */
class PathContext {
  constructor(workingContext) {
    this.worktreePath = workingContext.worktreePath;
    this.repositoryRoot = workingContext.repositoryRoot;
    this.relativeDirectory = workingContext.relativeDirectory || '';
    this.mode = workingContext.mode || 'worktree';
    
    // The actual working directory for this context
    this.workingDirectory = this.relativeDirectory 
      ? path.join(this.worktreePath, this.relativeDirectory)
      : this.worktreePath;
  }

  /**
   * Convert a file path to display format (relative to working directory)
   * @param {string} fullPath - Full path or repo-relative path
   * @returns {string} Path relative to working directory for display
   */
  toDisplayPath(fullPath) {
    // If we're not in a subdirectory, return as-is
    if (!this.relativeDirectory) {
      return fullPath;
    }
    
    // If it's already a relative path from repo root
    if (!path.isAbsolute(fullPath)) {
      // Check if the path starts with our relative directory
      if (fullPath.startsWith(this.relativeDirectory)) {
        // Remove the relative directory prefix
        const displayPath = path.relative(this.relativeDirectory, fullPath);
        return displayPath || '.';
      }
      // Path is outside our subdirectory context
      return fullPath;
    }
    
    // Convert absolute path to relative to working directory
    return path.relative(this.workingDirectory, fullPath);
  }

  /**
   * Convert a path to GitHub API format (relative to repository root)
   * @param {string} inputPath - Path from any context
   * @returns {string} Path relative to repository root for GitHub API
   */
  toGitHubPath(inputPath) {
    // If it's already relative and doesn't start with ../
    if (!path.isAbsolute(inputPath) && !inputPath.startsWith('..')) {
      // If we have a relative directory context, prepend it
      if (this.relativeDirectory && !inputPath.startsWith(this.relativeDirectory)) {
        return path.join(this.relativeDirectory, inputPath);
      }
      return inputPath;
    }
    
    // Convert absolute path to repo-relative
    if (path.isAbsolute(inputPath)) {
      return path.relative(this.repositoryRoot, inputPath);
    }
    
    // Handle relative paths that might go outside subdirectory
    const resolved = path.resolve(this.workingDirectory, inputPath);
    return path.relative(this.repositoryRoot, resolved);
  }

  /**
   * Get the directory where AI analysis should run
   * @returns {string} Directory path for AI execution
   */
  getAnalysisDirectory() {
    return this.workingDirectory;
  }

  /**
   * Check if a path is within the current subdirectory context
   * @param {string} filePath - Path to check
   * @returns {boolean} True if the path is within the subdirectory
   */
  isInSubdirectory(filePath) {
    if (!this.relativeDirectory) {
      return true; // No subdirectory restriction
    }
    
    const githubPath = this.toGitHubPath(filePath);
    return githubPath.startsWith(this.relativeDirectory);
  }

  /**
   * Filter changed files to only those in the subdirectory context
   * @param {Array} changedFiles - Array of file objects with 'file' property
   * @returns {Array} Filtered array of files in subdirectory
   */
  filterFilesToSubdirectory(changedFiles) {
    if (!this.relativeDirectory) {
      return changedFiles; // No filtering needed
    }
    
    return changedFiles.filter(file => this.isInSubdirectory(file.file));
  }

  /**
   * Get a summary of the context for logging
   * @returns {Object} Context summary
   */
  getSummary() {
    return {
      mode: this.mode,
      repositoryRoot: this.repositoryRoot,
      worktreePath: this.worktreePath,
      relativeDirectory: this.relativeDirectory || '(root)',
      workingDirectory: this.workingDirectory
    };
  }
}

module.exports = { PathContext };