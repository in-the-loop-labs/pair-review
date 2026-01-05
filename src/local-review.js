const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { loadConfig } = require('./config');
const { initializeDatabase, ReviewRepository } = require('./database');
const { startServer } = require('./server');
const { localReviewDiffs } = require('./routes/shared');
const open = (...args) => import('open').then(({ default: open }) => open(...args));

/**
 * Maximum file size in bytes for reading untracked files (1MB)
 */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Exit code returned by git diff --no-index when files differ
 * (exit code 1 means differences exist, not an error)
 */
const GIT_DIFF_HAS_DIFFERENCES = 1;

/**
 * Find the git repository root by walking up the directory tree
 * @param {string} startPath - Starting path to search from
 * @returns {Promise<string>} Absolute path to the git repository root
 * @throws {Error} If path is not within a git repository
 */
async function findGitRoot(startPath) {
  // Resolve to absolute path
  let currentPath = path.resolve(startPath);

  // Check if the starting path exists
  try {
    const stat = await fs.stat(currentPath);
    // If it's a file, start from its directory
    if (!stat.isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch (error) {
    throw new Error(`Path does not exist: ${startPath}`);
  }

  // Walk up the directory tree looking for .git
  while (currentPath !== path.dirname(currentPath)) {
    const gitPath = path.join(currentPath, '.git');
    try {
      await fs.access(gitPath);
      return currentPath;
    } catch {
      // .git not found, move up one directory
      currentPath = path.dirname(currentPath);
    }
  }

  // Check root directory as well
  const rootGitPath = path.join(currentPath, '.git');
  try {
    await fs.access(rootGitPath);
    return currentPath;
  } catch {
    throw new Error(`Not a git repository (or any of the parent directories): ${startPath}`);
  }
}

/**
 * Get the HEAD SHA of a git repository
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} HEAD commit SHA
 * @throws {Error} If git command fails
 */
async function getHeadSha(repoPath) {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return sha.trim();
  } catch (error) {
    throw new Error(`Failed to get HEAD SHA: ${error.message}`);
  }
}

/**
 * Get the repository name from git remote or fall back to directory name
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} Repository name (owner/repo format if available, or just repo name)
 */
async function getRepositoryName(repoPath) {
  try {
    // Try to get the remote URL
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (remoteUrl) {
      // Parse the repository name from the URL
      // Supports formats:
      // - https://github.com/owner/repo.git
      // - https://github.com/owner/repo
      // - git@github.com:owner/repo.git
      // - git@github.com:owner/repo
      // - ssh://git@github.com/owner/repo.git

      let repoName = remoteUrl;

      // Remove .git suffix if present
      if (repoName.endsWith('.git')) {
        repoName = repoName.slice(0, -4);
      }

      // Handle SSH format (git@github.com:owner/repo)
      if (repoName.includes(':') && repoName.includes('@')) {
        const colonIndex = repoName.lastIndexOf(':');
        repoName = repoName.substring(colonIndex + 1);
      } else {
        // Handle HTTPS or SSH URL format
        // Extract the path after the domain
        try {
          const url = new URL(repoName);
          repoName = url.pathname;
        } catch {
          // If URL parsing fails, try to extract path manually
          const match = repoName.match(/[/:]([\w.-]+\/[\w.-]+)$/);
          if (match) {
            repoName = match[1];
          }
        }
      }

      // Remove leading slash if present
      if (repoName.startsWith('/')) {
        repoName = repoName.substring(1);
      }

      // Validate we got something reasonable (should have owner/repo format)
      if (repoName && repoName.includes('/')) {
        return repoName;
      }

      // If we only got the repo part, return it
      if (repoName && repoName.length > 0) {
        return repoName;
      }
    }
  } catch (error) {
    // No remote configured or git command failed
    console.warn(`Could not get remote URL: ${error.message}`);
  }

  // Fall back to directory name
  return path.basename(repoPath);
}

/**
 * Get the current branch name
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} Current branch name or 'HEAD' if detached
 */
async function getCurrentBranch(repoPath) {
  try {
    const branch = execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const branchName = branch.trim();
    // If empty, we're in detached HEAD state
    return branchName || 'HEAD';
  } catch (error) {
    // Fallback - try to get branch from ref
    try {
      const ref = execSync('git symbolic-ref --short HEAD', {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return ref.trim() || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }
}

/**
 * Generate a local review ID from path and SHA
 * @param {string} repoPath - Absolute path to the repository
 * @param {string} headSha - HEAD commit SHA
 * @returns {string} Local review identifier
 */
function generateLocalReviewId(repoPath, headSha) {
  return `${repoPath}@${headSha}`;
}

/**
 * Check if a file is binary by checking for null bytes in the first 8KB
 * @param {Buffer} buffer - File content buffer
 * @returns {boolean} True if file appears to be binary
 */
function isBinaryFile(buffer) {
  // Check first 8KB for null bytes
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Get untracked files and their content
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<Array<{file: string, content: string, size: number, skipped: boolean, reason?: string}>>}
 */
async function getUntrackedFiles(repoPath) {
  try {
    // Get list of untracked files (excluding ignored files)
    const output = execSync('git ls-files --others --exclude-standard', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const files = output.trim().split('\n').filter(f => f.length > 0);

    // Process files in parallel for better performance
    // Use Promise.allSettled to process all files even if some fail
    const settledResults = await Promise.allSettled(files.map(async (file) => {
      const filePath = path.join(repoPath, file);

      try {
        const stat = await fs.stat(filePath);

        // Skip files larger than 1MB
        if (stat.size > MAX_FILE_SIZE) {
          return {
            file,
            content: '',
            size: stat.size,
            skipped: true,
            reason: 'File too large (>1MB)'
          };
        }

        // Read file content
        const buffer = await fs.readFile(filePath);

        // Skip binary files
        if (isBinaryFile(buffer)) {
          return {
            file,
            content: '',
            size: stat.size,
            skipped: true,
            reason: 'Binary file'
          };
        }

        return {
          file,
          content: buffer.toString('utf8'),
          size: stat.size,
          skipped: false
        };

      } catch (readError) {
        return {
          file,
          content: '',
          size: 0,
          skipped: true,
          reason: `Could not read file: ${readError.message}`
        };
      }
    }));

    // Filter successful results and handle rejections gracefully
    const results = settledResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Handle unexpected rejection (shouldn't happen due to inner try/catch, but be safe)
      console.warn(`Warning: Unexpected error processing file ${files[index]}: ${result.reason?.message || result.reason}`);
      return {
        file: files[index],
        content: '',
        size: 0,
        skipped: true,
        reason: `Unexpected error: ${result.reason?.message || result.reason}`
      };
    });

    return results;

  } catch (error) {
    console.warn(`Warning: Could not get untracked files: ${error.message}`);
    return [];
  }
}

/**
 * Generate diff for local changes (unstaged only, not staged)
 * Local mode shows unstaged changes + untracked files, NOT staged changes.
 * This allows users to stage files to "hide" them from the review.
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<{diff: string, untrackedFiles: Array, stats: Object}>}
 */
async function generateLocalDiff(repoPath) {
  let diff = '';
  const stats = {
    trackedChanges: 0,
    untrackedFiles: 0,
    stagedChanges: 0,
    unstagedChanges: 0
  };

  try {
    // Count staged changes for stats (but don't include in diff)
    // This is informational only - staged files are excluded from review
    const stagedDiff = execSync('git diff --cached --no-color --no-ext-diff --unified=25', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });

    if (stagedDiff.trim()) {
      stats.stagedChanges = (stagedDiff.match(/^diff --git/gm) || []).length;
    }

    // Get unstaged changes to tracked files (this is what we show in the review)
    const unstagedDiff = execSync('git diff --no-color --no-ext-diff --unified=25', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });

    if (unstagedDiff.trim()) {
      diff += unstagedDiff;
      stats.unstagedChanges = (unstagedDiff.match(/^diff --git/gm) || []).length;
    }

    stats.trackedChanges = stats.unstagedChanges;

  } catch (error) {
    console.warn(`Warning: Could not generate diff for tracked files: ${error.message}`);
  }

  // Get untracked files
  const untrackedFiles = await getUntrackedFiles(repoPath);
  stats.untrackedFiles = untrackedFiles.length;

  // Generate authentic git diff for untracked files using git diff --no-index
  for (const untracked of untrackedFiles) {
    if (!untracked.skipped) {
      try {
        const filePath = path.join(repoPath, untracked.file);
        // git diff --no-index exits with code 1 when files differ, code 0 when identical
        let fileDiff;
        try {
          fileDiff = execSync(`git diff --no-index --no-color --no-ext-diff -- /dev/null "${filePath}"`, {
            cwd: repoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer per file
          });
        } catch (diffError) {
          // git diff --no-index returns exit code 1 when files differ (expected case)
          // Exit code 1 with stdout means files differ - this is the normal case for new files
          if (diffError.status === GIT_DIFF_HAS_DIFFERENCES && typeof diffError.stdout === 'string') {
            fileDiff = diffError.stdout;
          } else {
            // Any other error (status !== 1 or no stdout) is a real error
            throw diffError;
          }
        }

        if (fileDiff && fileDiff.trim()) {
          // The diff output shows the absolute path, normalize it to relative path
          // Replace /dev/null comparison paths with the relative file path
          const normalizedDiff = fileDiff
            .replace(/^diff --git a\/dev\/null b\/.+$/m, `diff --git a/${untracked.file} b/${untracked.file}`)
            .replace(/^\+\+\+ b\/.+$/m, `+++ b/${untracked.file}`);

          if (diff) {
            diff += '\n';
          }
          diff += normalizedDiff;
        }
      } catch (fileError) {
        console.warn(`Warning: Could not generate diff for untracked file ${untracked.file}: ${fileError.message}`);
      }
    }
  }

  return {
    diff,
    untrackedFiles,
    stats
  };
}

/**
 * Handle local review mode
 * @param {string} targetPath - Target path to review (file or directory)
 * @param {Object} flags - Command line flags
 * @returns {Promise<void>}
 */
async function handleLocalReview(targetPath, flags = {}) {
  let db = null;

  try {
    // Resolve target path
    const resolvedPath = path.resolve(targetPath || process.cwd());

    // Validate path exists
    try {
      await fs.access(resolvedPath);
    } catch {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    // Find git repository root
    console.log(`Finding git repository root from ${resolvedPath}...`);
    const repoPath = await findGitRoot(resolvedPath);
    console.log(`Found git repository at: ${repoPath}`);

    // Get HEAD SHA for session identity
    const headSha = await getHeadSha(repoPath);
    console.log(`HEAD SHA: ${headSha}`);

    // Get current branch
    const branch = await getCurrentBranch(repoPath);
    console.log(`Current branch: ${branch}`);

    // Generate local review ID
    const reviewId = generateLocalReviewId(repoPath, headSha);
    console.log(`Local review ID: ${reviewId}`);

    // Load configuration
    const config = await loadConfig();

    // Initialize database
    console.log('Initializing database...');
    db = await initializeDatabase();

    // Check for existing session or create new one
    const reviewRepo = new ReviewRepository(db);
    const repository = await getRepositoryName(repoPath);
    console.log(`Repository: ${repository}`);

    console.log('Checking for existing review session...');
    const existingReview = await reviewRepo.getLocalReview(repoPath, headSha);

    let sessionId;
    if (existingReview) {
      console.log(`Resuming existing review session (ID: ${existingReview.id})`);
      sessionId = existingReview.id;
    } else {
      console.log('Creating new review session...');
      sessionId = await reviewRepo.upsertLocalReview({
        localPath: repoPath,
        localHeadSha: headSha,
        repository
      });
      console.log(`Created new review session (ID: ${sessionId})`);
    }

    // Generate local diff
    console.log('Generating diff for local changes...');
    const { diff, untrackedFiles, stats } = await generateLocalDiff(repoPath);

    if (!diff && untrackedFiles.length === 0) {
      console.log('\nNo local changes detected.');
      console.log('Make some changes to your files and run pair-review --local again.\n');
      return;
    }

    console.log(`Found changes:`);
    if (stats.unstagedChanges > 0) {
      console.log(`  - ${stats.unstagedChanges} unstaged file(s)`);
    }
    if (stats.untrackedFiles > 0) {
      const skipped = untrackedFiles.filter(f => f.skipped).length;
      const included = stats.untrackedFiles - skipped;
      console.log(`  - ${included} untracked file(s)${skipped > 0 ? ` (${skipped} skipped)` : ''}`);
    }
    if (stats.stagedChanges > 0) {
      console.log(`  - ${stats.stagedChanges} staged file(s) (excluded from review)`);
    }

    // Set environment variables for local mode (metadata only, not large data)
    process.env.PAIR_REVIEW_LOCAL = 'true';
    process.env.PAIR_REVIEW_LOCAL_PATH = repoPath;
    process.env.PAIR_REVIEW_LOCAL_ID = String(sessionId);
    process.env.PAIR_REVIEW_REPOSITORY = repository;
    process.env.PAIR_REVIEW_BRANCH = branch;
    process.env.PAIR_REVIEW_LOCAL_HEAD_SHA = headSha;

    // Store diff data in module-level Map (avoids process.env size limits and security concerns)
    localReviewDiffs.set(sessionId, { diff, stats });

    // Set model override if provided
    if (flags.model) {
      process.env.PAIR_REVIEW_MODEL = flags.model;
    }

    // Start server
    console.log('Starting server...');
    const port = await startServer(db);

    // Open browser to local review view
    const url = `http://localhost:${port}/local/${sessionId}`;
    console.log(`\nOpening browser to: ${url}`);
    await open(url);

    console.log(`\nLocal review session started.`);
    console.log(`Repository: ${repoPath}`);
    console.log(`Branch: ${branch}`);
    console.log(`Session ID: ${sessionId}\n`);

  } catch (error) {
    // Close database on error
    if (db) {
      db.close();
    }

    // Provide cleaner error messages for common issues
    if (error.message.includes('does not exist')) {
      console.error(`\n[ERROR] ${error.message}\n`);
    } else if (error.message.includes('Not a git repository')) {
      console.error(`\n[ERROR] ${error.message}`);
      console.error('Please run this command from within a git repository.\n');
    } else if (error.message.includes('Failed to get HEAD SHA')) {
      console.error(`\n[ERROR] ${error.message}`);
      console.error('Make sure the repository has at least one commit.\n');
    } else {
      console.error(`\n[ERROR] Error: ${error.message}\n`);
    }
    throw error;
  }
}

module.exports = {
  handleLocalReview,
  findGitRoot,
  getHeadSha,
  getRepositoryName,
  getCurrentBranch,
  generateLocalDiff,
  generateLocalReviewId,
  getUntrackedFiles
};
