// SPDX-License-Identifier: GPL-3.0-or-later
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const { loadConfig, showWelcomeMessage, resolveDbName, getGitHubToken } = require('./config');
const logger = require('./utils/logger');
const { fireHooks, hasHooks } = require('./hooks/hook-runner');
const { buildReviewStartedPayload, buildReviewLoadedPayload, getCachedUser } = require('./hooks/payloads');

const execAsync = promisify(exec);
const { STOPS, scopeIncludes, includesBranch, DEFAULT_SCOPE, scopeLabel } = require('./local-scope');
const { initializeDatabase, ReviewRepository, RepoSettingsRepository } = require('./database');
const { startServer } = require('./server');
const { localReviewDiffs } = require('./routes/shared');
const { getShaAbbrevLength } = require('./git/sha-abbrev');
const open = (...args) => import('open').then(({ default: open }) => open(...args));

// Design note: This module uses execSync for git commands despite async function signatures.
// For a local CLI tool, synchronous execution is acceptable and simplifies error handling.
// The async signatures allow mixing with truly async operations (fs.promises, database calls)
// without requiring callers to handle mixed sync/async patterns.

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
 * Find the main git repository root, resolving through worktrees.
 * For regular repos, returns the repo root.
 * For worktrees, returns the parent/main repository root (not the worktree path).
 *
 * Uses `git rev-parse --git-common-dir` which returns the common .git directory:
 * - For regular repos: returns ".git"
 * - For worktrees: returns the path to the main repo's .git directory (e.g., "/path/to/main/.git")
 *
 * @param {string} repoPath - Path within a git repository (or worktree)
 * @returns {Promise<string>} Absolute path to the main git repository root
 * @throws {Error} If path is not within a git repository
 */
async function findMainGitRoot(repoPath) {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // If commonDir is just ".git", this is a regular repo - return the repoPath
    // Normalize through path.resolve() for consistency with worktree case
    if (commonDir === '.git') {
      return path.resolve(repoPath);
    }

    // For worktrees, commonDir is an absolute path like "/path/to/main/.git"
    // or a relative path like "../main/.git"
    const resolvedCommonDir = path.resolve(repoPath, commonDir);

    // Determine if this is a .git directory (regular repo) or a bare repo
    // Regular repos: commonDir ends with ".git" (e.g., /path/to/repo/.git)
    // Bare repos: commonDir is the repo itself (e.g., /path/to/repo.git or /path/to/git)
    // The key difference: for regular repos, basename is exactly ".git"
    const basename = path.basename(resolvedCommonDir);
    if (basename === '.git') {
      // Regular repo - go up one level to get the repo root
      return path.dirname(resolvedCommonDir);
    } else {
      // Bare repo - the commonDir IS the repo
      return resolvedCommonDir;
    }
  } catch (error) {
    throw new Error(`Failed to find main git root: ${error.message}`);
  }
}

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
 * Find merge-base between baseBranch and HEAD using local refs.
 * This is only used in local review mode where the local ref is authoritative.
 * @param {string} repoPath - Path to the git repository
 * @param {string} baseBranch - Base branch name
 * @returns {Promise<string>} Merge-base SHA
 */
async function findMergeBase(repoPath, baseBranch) {
  if (!baseBranch || !/^[\w.\-\/]+$/.test(baseBranch)) {
    throw new Error(`Invalid branch name: ${baseBranch}`);
  }

  try {
    return execSync(`git merge-base ${baseBranch} HEAD`, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    throw new Error(`Could not find merge-base between ${baseBranch} and HEAD: ${error.message}`);
  }
}

/**
 * Generate diff output for untracked files using git diff --no-index.
 * @param {string} repoPath - Path to the git repository
 * @param {Array} untrackedFiles - Array from getUntrackedFiles()
 * @param {string} wFlag - Whitespace flag (e.g. ' -w' or '')
 * @returns {string} Combined diff text for untracked files
 */
function generateUntrackedDiffs(repoPath, untrackedFiles, wFlag) {
  let diff = '';
  for (const untracked of untrackedFiles) {
    if (!untracked.skipped) {
      try {
        const filePath = path.join(repoPath, untracked.file);
        let fileDiff;
        try {
          fileDiff = execSync(`git diff --no-index --no-color --no-ext-diff${wFlag} -- /dev/null "${filePath}"`, {
            cwd: repoPath,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024
          });
        } catch (diffError) {
          if (diffError && typeof diffError === 'object' &&
              diffError.status === GIT_DIFF_HAS_DIFFERENCES && typeof diffError.stdout === 'string') {
            fileDiff = diffError.stdout;
          } else {
            throw diffError;
          }
        }

        if (fileDiff && fileDiff.trim()) {
          const normalizedDiff = fileDiff
            .replace(/^diff --git a\/.+? b\/.+$/m, `diff --git a/${untracked.file} b/${untracked.file}`)
            .replace(/^\+\+\+ b\/.+$/m, `+++ b/${untracked.file}`);

          if (diff) {
            diff += '\n';
          }
          diff += normalizedDiff;
        }
      } catch (fileError) {
        logger.warn(`Could not generate diff for untracked file ${untracked.file}: ${fileError.message}`);
      }
    }
  }
  return diff;
}

/**
 * Generate diff for a given scope range.
 *
 * Scope stops: branch → staged → unstaged → untracked
 * When branch is in scope, diffs anchor against merge-base.
 * Otherwise, diffs anchor against HEAD (staged) or INDEX (unstaged).
 *
 * @param {string} repoPath - Path to the git repository
 * @param {string} scopeStart - Start of scope range (e.g. 'unstaged', 'branch')
 * @param {string} scopeEnd - End of scope range (e.g. 'untracked', 'branch')
 * @param {string} [baseBranch] - Base branch name (required when branch is in scope)
 * @param {Object} [options]
 * @param {boolean} [options.hideWhitespace] - Whether to hide whitespace changes
 * @returns {Promise<{diff: string, stats: Object, mergeBaseSha: string|null}>}
 */
async function generateScopedDiff(repoPath, scopeStart, scopeEnd, baseBranch, options = {}) {
  const wFlag = options.hideWhitespace ? ' -w' : '';
  const stats = {
    trackedChanges: 0,
    untrackedFiles: 0,
    stagedChanges: 0,
    unstagedChanges: 0
  };

  const hasBranch = scopeIncludes(scopeStart, scopeEnd, 'branch');
  const hasStaged = scopeIncludes(scopeStart, scopeEnd, 'staged');
  const hasUnstaged = scopeIncludes(scopeStart, scopeEnd, 'unstaged');
  const hasUntracked = scopeIncludes(scopeStart, scopeEnd, 'untracked');

  let mergeBaseSha = null;
  let diff = '';

  // Resolve merge-base when branch is in scope
  if (hasBranch) {
    if (!baseBranch) {
      throw new Error('baseBranch is required when scope includes branch');
    }
    mergeBaseSha = await findMergeBase(repoPath, baseBranch);
  }

  // Build the git diff command based on scope range
  try {
    if (hasBranch && !hasStaged && !hasUnstaged) {
      // Branch only → committed changes since merge-base
      diff = execSync(`git diff ${mergeBaseSha}..HEAD --no-color --no-ext-diff --unified=25${wFlag}`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
    } else if (hasBranch && hasStaged && !hasUnstaged) {
      // Branch–Staged → staged changes relative to merge-base
      diff = execSync(`git diff --cached ${mergeBaseSha} --no-color --no-ext-diff --unified=25${wFlag}`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
    } else if (hasBranch && hasUnstaged) {
      // Branch–Unstaged (or Branch–Untracked) → working tree vs merge-base
      diff = execSync(`git diff ${mergeBaseSha} --no-color --no-ext-diff --unified=25${wFlag}`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
    } else if (hasStaged && !hasUnstaged) {
      // Staged only → cached changes
      diff = execSync(`git diff --cached --no-color --no-ext-diff --unified=25${wFlag}`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
    } else if (hasStaged && hasUnstaged) {
      // Staged–Unstaged (or Staged–Untracked) → all changes vs HEAD
      diff = execSync(`git diff HEAD --no-color --no-ext-diff --unified=25${wFlag}`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
    } else if (hasUnstaged) {
      // Unstaged only or Unstaged–Untracked → working tree changes
      diff = execSync(`git diff --no-color --no-ext-diff --unified=25${wFlag}`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024
      });
    }
    // hasUntracked-only: no git diff needed, just untracked files below
  } catch (error) {
    if (error.message && error.message.includes('maxBuffer')) {
      throw new Error('Diff output exceeded maximum buffer size (50MB).');
    }
    throw new Error(`Failed to generate scoped diff: ${error.message}`);
  }

  if (diff.trim()) {
    stats.trackedChanges = (diff.match(/^diff --git/gm) || []).length;
  }

  // Count staged/unstaged for stats when relevant
  if (hasStaged) {
    try {
      const stagedDiff = execSync(`git diff --cached --stat --no-color --no-ext-diff`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      if (stagedDiff.trim()) {
        stats.stagedChanges = (stagedDiff.match(/\|/g) || []).length;
      }
    } catch { /* non-critical */ }
  }
  if (hasUnstaged) {
    try {
      const unstagedDiff = execSync(`git diff --stat --no-color --no-ext-diff`, {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      if (unstagedDiff.trim()) {
        stats.unstagedChanges = (unstagedDiff.match(/\|/g) || []).length;
      }
    } catch { /* non-critical */ }
  }

  // Append untracked file diffs
  if (hasUntracked) {
    const untrackedFiles = await getUntrackedFiles(repoPath);
    stats.untrackedFiles = untrackedFiles.length;

    const untrackedDiff = generateUntrackedDiffs(repoPath, untrackedFiles, wFlag);
    if (untrackedDiff) {
      if (diff) diff += '\n';
      diff += untrackedDiff;
    }
  }

  return { diff, stats, mergeBaseSha };
}

/**
 * Compute a content digest for the current scope.
 * Used for staleness detection — if the digest changes, the scope content changed.
 *
 * @param {string} repoPath - Path to the git repository
 * @param {string} scopeStart - Start of scope range
 * @param {string} scopeEnd - End of scope range
 * @returns {Promise<string|null>} 16-char hex digest, or null on error
 */
async function computeScopedDigest(repoPath, scopeStart, scopeEnd) {
  let hasError = false;
  const parts = [];

  // Branch in scope → HEAD SHA matters
  if (scopeIncludes(scopeStart, scopeEnd, 'branch')) {
    try {
      const result = await execAsync('git rev-parse HEAD', {
        cwd: repoPath, encoding: 'utf8'
      });
      parts.push('HEAD:' + result.stdout.trim());
    } catch {
      hasError = true;
    }
  }

  // Staged in scope → cached diff content
  if (scopeIncludes(scopeStart, scopeEnd, 'staged')) {
    try {
      const result = await execAsync('git diff --cached --no-ext-diff', {
        cwd: repoPath, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024
      });
      parts.push('STAGED:' + result.stdout);
    } catch {
      hasError = true;
    }
  }

  // Unstaged in scope → working tree diff
  if (scopeIncludes(scopeStart, scopeEnd, 'unstaged')) {
    try {
      const result = await execAsync('git diff --no-ext-diff', {
        cwd: repoPath, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024
      });
      parts.push('UNSTAGED:' + result.stdout);
    } catch {
      hasError = true;
    }
  }

  // Untracked in scope → file list with sizes/mtimes
  if (scopeIncludes(scopeStart, scopeEnd, 'untracked')) {
    try {
      const result = await execAsync('git ls-files --others --exclude-standard', {
        cwd: repoPath, encoding: 'utf8'
      });
      const files = result.stdout.trim().split('\n').filter(f => f.length > 0);
      let untrackedInfo = '';
      for (const file of files) {
        try {
          const fileStat = await fs.stat(path.join(repoPath, file));
          untrackedInfo += `${file}:${fileStat.size}:${fileStat.mtimeMs}\n`;
        } catch {
          untrackedInfo += `${file}:missing\n`;
        }
      }
      parts.push('UNTRACKED:' + untrackedInfo);
    } catch {
      hasError = true;
    }
  }

  if (hasError && parts.length === 0) {
    return null;
  }

  const combined = parts.join('\n---\n');
  return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16);
}

/**
 * Generate diff for local changes (unstaged + untracked).
 * Thin wrapper around generateScopedDiff with legacy return shape.
 * @param {string} repoPath - Path to the git repository
 * @param {Object} [options]
 * @param {boolean} [options.hideWhitespace] - Whether to hide whitespace changes
 * @returns {Promise<{diff: string, untrackedFiles: Array, stats: Object}>}
 */
async function generateLocalDiff(repoPath, options = {}) {
  const result = await generateScopedDiff(repoPath, 'unstaged', 'untracked', null, options);
  // Preserve legacy untrackedFiles field
  const untrackedFiles = await getUntrackedFiles(repoPath);

  // Always count staged changes for CLI info message, even when staged is out of scope
  if (!result.stats.stagedChanges) {
    try {
      const stagedStat = execSync('git diff --cached --stat --no-color --no-ext-diff', {
        cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
      });
      if (stagedStat.trim()) {
        result.stats.stagedChanges = (stagedStat.match(/\|/g) || []).length;
      }
    } catch { /* non-critical */ }
  }

  return {
    diff: result.diff,
    untrackedFiles,
    stats: result.stats
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
    const { config, isFirstRun } = await loadConfig();

    // Show welcome message on first run
    if (isFirstRun) {
      showWelcomeMessage();
    }

    // Initialize database
    console.log('Initializing database...');
    db = await initializeDatabase(resolveDbName(config));

    // Check for existing session or create new one
    const reviewRepo = new ReviewRepository(db);
    const repository = await getRepositoryName(repoPath);
    console.log(`Repository: ${repository}`);

    // If this is a GitHub repository (has owner/repo format), register the local path
    // This enables future web UI sessions to find this repository without cloning
    // Use findMainGitRoot to resolve worktrees to their parent repo
    if (repository.includes('/')) {
      try {
        const mainRepoRoot = await findMainGitRoot(repoPath);
        const repoSettingsRepo = new RepoSettingsRepository(db);
        await repoSettingsRepo.setLocalPath(repository, mainRepoRoot);
        console.log(`Registered repository location: ${mainRepoRoot}`);
      } catch (error) {
        // Non-fatal: registration failure shouldn't block the review
        console.warn(`Could not register repository location: ${error.message}`);
      }
    }

    console.log('Checking for existing review session...');
    let existingReview = await reviewRepo.getLocalReview(repoPath, headSha, branch);

    if (!existingReview) {
      // Adopt legacy sessions that predate branch tracking (local_head_branch is NULL)
      const legacy = await reviewRepo.getLocalReviewByPathAndSha(repoPath, headSha);
      if (legacy && legacy.local_head_branch === null) {
        existingReview = legacy;
      }
    }

    if (!existingReview) {
      // Check for existing branch-scope session on this path
      // (branch scope sessions persist across HEAD changes)
      const branchSession = await reviewRepo.getLocalBranchReview(repoPath, branch);
      if (branchSession) {
        existingReview = branchSession;
      }
    }

    let sessionId;
    if (existingReview) {
      sessionId = existingReview.id;
      // Update HEAD SHA if it changed (branch mode: new commits on same branch)
      if (existingReview.local_head_sha !== headSha) {
        await reviewRepo.updateLocalHeadSha(sessionId, headSha);
        const abbrevLen = getShaAbbrevLength(repoPath);
        console.log(`Updated HEAD SHA on session ${sessionId}: ${existingReview.local_head_sha.substring(0, abbrevLen)} -> ${headSha.substring(0, abbrevLen)}`);
      }
      // Backfill branch on legacy sessions
      if (existingReview.local_head_branch === null) {
        await reviewRepo.updateReview(sessionId, { local_head_branch: branch });
        console.log(`Backfilled branch on session ${sessionId}: ${branch}`);
      }
      console.log(`Resuming existing review session (ID: ${existingReview.id})`);
    } else {
      console.log('Creating new review session...');
      sessionId = await reviewRepo.upsertLocalReview({
        localPath: repoPath,
        localHeadSha: headSha,
        repository,
        localHeadBranch: branch
      });
      console.log(`Created new review session (ID: ${sessionId})`);
    }

    // Read scope from session (or use defaults for new sessions)
    const scopeStart = existingReview?.local_scope_start || DEFAULT_SCOPE.start;
    const scopeEnd = existingReview?.local_scope_end || DEFAULT_SCOPE.end;

    // Fire review hook (non-blocking)
    const hookEvent = existingReview ? 'review.loaded' : 'review.started';
    if (hasHooks(hookEvent, config)) {
      getCachedUser(config).then(user => {
        const builder = existingReview ? buildReviewLoadedPayload : buildReviewStartedPayload;
        const si = STOPS.indexOf(scopeStart);
        const ei = STOPS.indexOf(scopeEnd);
        const scope = STOPS.slice(si, ei + 1);
        const payload = builder({ reviewId: sessionId, mode: 'local', localContext: { path: repoPath, branch, headSha, scope }, user });
        fireHooks(hookEvent, payload, config);
      }).catch(err => { logger.warn(`Review hook failed: ${err.message}`); });
    }
    const baseBranch = existingReview?.local_base_branch || null;

    // Generate diff using session's actual scope
    console.log(`Generating diff for scope: ${scopeLabel(scopeStart, scopeEnd)}...`);
    const { diff, stats } = await generateScopedDiff(repoPath, scopeStart, scopeEnd, baseBranch);

    // Branch detection: when scope does NOT include branch and no uncommitted changes,
    // check if branch has commits ahead (frontend uses this to suggest expanding scope)
    let branchInfo = null;
    if (!includesBranch(scopeStart)) {
      const untrackedFiles = await getUntrackedFiles(repoPath);
      branchInfo = await detectAndBuildBranchInfo(repoPath, branch, {
        repository,
        diff,
        untrackedFiles,
        githubToken: getGitHubToken(config),
        enableGraphite: config.enable_graphite === true
      });
      if (branchInfo) {
        console.log(`\nNo uncommitted changes, but branch has ${branchInfo.commitCount} commit(s) ahead of ${branchInfo.baseBranch}.`);
        console.log('The UI will offer to review branch changes.');
      }
    }

    if (!diff && !branchInfo) {
      console.log('\nNo changes detected in current scope. The UI will open anyway - you can change scope or make changes and refresh.');
    } else if (diff) {
      console.log(`Found ${stats.trackedChanges || 0} file(s) changed`);
      if (stats.untrackedFiles > 0) {
        console.log(`  - ${stats.untrackedFiles} untracked file(s)`);
      }
      if (stats.stagedChanges > 0 && !scopeIncludes(scopeStart, scopeEnd, 'staged')) {
        console.log(`  - ${stats.stagedChanges} staged file(s) (outside current scope)`);
      }
    }

    // Set environment variables for local mode (metadata only, not large data)
    process.env.PAIR_REVIEW_LOCAL = 'true';
    process.env.PAIR_REVIEW_LOCAL_PATH = repoPath;
    process.env.PAIR_REVIEW_LOCAL_ID = String(sessionId);
    process.env.PAIR_REVIEW_REPOSITORY = repository;
    process.env.PAIR_REVIEW_BRANCH = branch;
    process.env.PAIR_REVIEW_LOCAL_HEAD_SHA = headSha;

    // Compute baseline digest NOW for accurate staleness detection later
    // This must be done at diff-capture time, not lazily at check time
    const digest = await computeScopedDigest(repoPath, scopeStart, scopeEnd);

    // Store diff data in module-level Map (avoids process.env size limits and security concerns)
    localReviewDiffs.set(sessionId, { diff, stats, digest, branchInfo });

    // Persist diff to database so past sessions remain viewable without the server running
    try {
      const reviewRepo = new ReviewRepository(db);
      await reviewRepo.saveLocalDiff(sessionId, { diff, stats, digest });
    } catch (persistError) {
      logger.warn(`Could not persist diff to database: ${persistError.message}`);
    }

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

/**
 * Compute a hash digest of local changes for staleness detection.
 * Thin wrapper around computeScopedDigest with scope unstaged→untracked.
 * @param {string} localPath - Path to the local git repository
 * @returns {Promise<string|null>} 16-character hex digest or null on error
 */
async function computeLocalDiffDigest(localPath) {
  return computeScopedDigest(localPath, 'unstaged', 'untracked');
}

/**
 * Generate diff for committed branch changes against a base branch.
 * Thin wrapper around generateScopedDiff with scope branch→branch.
 *
 * @param {string} repoPath - Path to the git repository
 * @param {string} baseBranch - Base branch name (e.g. 'main')
 * @param {Object} [options]
 * @param {boolean} [options.hideWhitespace] - Whether to hide whitespace changes
 * @returns {Promise<{diff: string, stats: Object, mergeBaseSha: string}>}
 */
async function generateBranchDiff(repoPath, baseBranch, options = {}) {
  return generateScopedDiff(repoPath, 'branch', 'branch', baseBranch, options);
}

/**
 * Get the number of commits on the current branch ahead of the base branch.
 * @param {string} repoPath - Path to the git repository
 * @param {string} baseBranch - Base branch name
 * @returns {Promise<number>} Number of commits ahead
 */
async function getBranchCommitCount(repoPath, baseBranch) {
  if (!baseBranch || !/^[\w.\-\/]+$/.test(baseBranch)) {
    throw new Error(`Invalid branch name: ${baseBranch}`);
  }

  // Try origin/<base> first, fall back to local <base>
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const count = execSync(`git rev-list --count ${ref}..HEAD`, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      return parseInt(count, 10) || 0;
    } catch {
      // Try next ref
    }
  }
  return 0;
}

/**
 * Get the subject of the first commit on the branch relative to the base.
 * Used as the default review name.
 * @param {string} repoPath - Path to the git repository
 * @param {string} baseBranch - Base branch name
 * @returns {Promise<string|null>} First commit subject or null
 */
async function getFirstCommitSubject(repoPath, baseBranch) {
  if (!baseBranch || !/^[\w.\-\/]+$/.test(baseBranch)) {
    throw new Error(`Invalid branch name: ${baseBranch}`);
  }

  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const output = execSync(`git log ${ref}..HEAD --format=%s --reverse`, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      const firstLine = output.split('\n')[0];
      return firstLine || null;
    } catch {
      // Try next ref
    }
  }
  return null;
}

/**
 * Detect whether the current branch has commits ahead of its base branch
 * and build a branchInfo object suitable for the frontend prompt.
 *
 * Encapsulates the full sequence: guard checks -> detectBaseBranch -> getBranchCommitCount.
 * All call sites should use this instead of assembling branchInfo inline.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @param {string} branch - Current branch name
 * @param {Object} options
 * @param {string} options.repository - owner/repo string
 * @param {string} [options.diff] - The uncommitted diff content (empty = eligible)
 * @param {Array} [options.untrackedFiles] - Untracked files array (empty = eligible)
 * @param {string} [options.githubToken] - Resolved GitHub token for PR lookup
 * @param {boolean} [options.enableGraphite] - When true, try Graphite CLI for parent branch
 * @returns {Promise<{baseBranch: string, commitCount: number, source: string, prNumber?: number}|null>}
 */
async function detectAndBuildBranchInfo(repoPath, branch, options = {}) {
  const { repository, diff, untrackedFiles, githubToken, enableGraphite } = options;

  // Guard: detached HEAD, has uncommitted changes, or has untracked files
  if (branch === 'HEAD') return null;
  if (diff) return null;
  if (untrackedFiles && untrackedFiles.length > 0) return null;

  try {
    const { detectBaseBranch } = require('./git/base-branch');
    const depsOverride = githubToken ? { getGitHubToken: () => githubToken } : undefined;
    const detection = await detectBaseBranch(repoPath, branch, {
      repository,
      enableGraphite,
      _deps: depsOverride
    });
    if (!detection) return null;

    const commitCount = await getBranchCommitCount(repoPath, detection.baseBranch);
    if (commitCount <= 0) return null;

    return {
      baseBranch: detection.baseBranch,
      commitCount,
      source: detection.source,
      prNumber: detection.prNumber || null
    };
  } catch (error) {
    logger.warn(`Branch detection failed: ${error.message}`);
    return null;
  }
}

module.exports = {
  handleLocalReview,
  findGitRoot,
  findMainGitRoot,
  getHeadSha,
  getRepositoryName,
  getCurrentBranch,
  generateLocalDiff,
  generateBranchDiff,
  generateScopedDiff,
  getBranchCommitCount,
  getFirstCommitSubject,
  detectAndBuildBranchInfo,
  generateLocalReviewId,
  getUntrackedFiles,
  computeLocalDiffDigest,
  computeScopedDigest,
  findMergeBase
};
