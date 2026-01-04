const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { loadConfig } = require('./config');
const { initializeDatabase, ReviewRepository } = require('./database');
const { startServer } = require('./server');
const open = (...args) => import('open').then(({ default: open }) => open(...args));

/**
 * Maximum file size in bytes for reading untracked files (1MB)
 */
const MAX_FILE_SIZE = 1024 * 1024;

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
  const results = [];

  try {
    // Get list of untracked files (excluding ignored files)
    const output = execSync('git ls-files --others --exclude-standard', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const files = output.trim().split('\n').filter(f => f.length > 0);

    for (const file of files) {
      const filePath = path.join(repoPath, file);

      try {
        const stat = await fs.stat(filePath);

        // Skip files larger than 1MB
        if (stat.size > MAX_FILE_SIZE) {
          results.push({
            file,
            content: '',
            size: stat.size,
            skipped: true,
            reason: 'File too large (>1MB)'
          });
          continue;
        }

        // Read file content
        const buffer = await fs.readFile(filePath);

        // Skip binary files
        if (isBinaryFile(buffer)) {
          results.push({
            file,
            content: '',
            size: stat.size,
            skipped: true,
            reason: 'Binary file'
          });
          continue;
        }

        results.push({
          file,
          content: buffer.toString('utf8'),
          size: stat.size,
          skipped: false
        });

      } catch (readError) {
        results.push({
          file,
          content: '',
          size: 0,
          skipped: true,
          reason: `Could not read file: ${readError.message}`
        });
      }
    }

  } catch (error) {
    console.warn(`Warning: Could not get untracked files: ${error.message}`);
  }

  return results;
}

/**
 * Generate diff for local changes (staged + unstaged)
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
    // Get staged changes
    const stagedDiff = execSync('git diff --cached --no-color --no-ext-diff --unified=25', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });

    if (stagedDiff.trim()) {
      diff += stagedDiff;
      stats.stagedChanges = (stagedDiff.match(/^diff --git/gm) || []).length;
    }

    // Get unstaged changes to tracked files
    const unstagedDiff = execSync('git diff --no-color --no-ext-diff --unified=25', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer
    });

    if (unstagedDiff.trim()) {
      // Add separator if we already have staged changes
      if (diff && unstagedDiff.trim()) {
        diff += '\n';
      }
      diff += unstagedDiff;
      stats.unstagedChanges = (unstagedDiff.match(/^diff --git/gm) || []).length;
    }

    stats.trackedChanges = stats.stagedChanges + stats.unstagedChanges;

  } catch (error) {
    console.warn(`Warning: Could not generate diff for tracked files: ${error.message}`);
  }

  // Get untracked files
  const untrackedFiles = await getUntrackedFiles(repoPath);
  stats.untrackedFiles = untrackedFiles.length;

  // Generate pseudo-diff for untracked files (new file format)
  for (const untracked of untrackedFiles) {
    if (!untracked.skipped && untracked.content) {
      const lines = untracked.content.split('\n');
      const lineCount = lines.length;

      // Create a diff-like format for new files
      const fileDiff = [
        `diff --git a/${untracked.file} b/${untracked.file}`,
        'new file mode 100644',
        `index 0000000..0000000`,
        `--- /dev/null`,
        `+++ b/${untracked.file}`,
        `@@ -0,0 +1,${lineCount} @@`,
        ...lines.map(line => `+${line}`)
      ].join('\n');

      if (diff) {
        diff += '\n';
      }
      diff += fileDiff;
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
    const repository = path.basename(repoPath);

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
    if (stats.stagedChanges > 0) {
      console.log(`  - ${stats.stagedChanges} staged file(s)`);
    }
    if (stats.unstagedChanges > 0) {
      console.log(`  - ${stats.unstagedChanges} unstaged file(s)`);
    }
    if (stats.untrackedFiles > 0) {
      const skipped = untrackedFiles.filter(f => f.skipped).length;
      const included = stats.untrackedFiles - skipped;
      console.log(`  - ${included} untracked file(s)${skipped > 0 ? ` (${skipped} skipped)` : ''}`);
    }

    // Set environment variables for local mode
    process.env.PAIR_REVIEW_LOCAL = 'true';
    process.env.PAIR_REVIEW_LOCAL_PATH = repoPath;
    process.env.PAIR_REVIEW_LOCAL_ID = String(sessionId);
    process.env.PAIR_REVIEW_REPOSITORY = repository;
    process.env.PAIR_REVIEW_BRANCH = branch;
    process.env.PAIR_REVIEW_LOCAL_HEAD_SHA = headSha;

    // Store diff data for the server to access
    process.env.PAIR_REVIEW_LOCAL_DIFF = diff;
    process.env.PAIR_REVIEW_LOCAL_STATS = JSON.stringify(stats);

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
  getCurrentBranch,
  generateLocalDiff,
  generateLocalReviewId,
  getUntrackedFiles
};
