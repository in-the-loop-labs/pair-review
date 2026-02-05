// SPDX-License-Identifier: GPL-3.0-or-later
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { getConfigDir } = require('../config');
const { WorktreeRepository, generateWorktreeId } = require('../database');
const { getGeneratedFilePatterns } = require('./gitattributes');
const { normalizeRepository, resolveRenamedFile, resolveRenamedFileOld } = require('../utils/paths');

/**
 * Git worktree manager for handling PR branch checkouts and diffs
 */
class GitWorktreeManager {
  /**
   * Create a new GitWorktreeManager instance
   * @param {sqlite3.Database} [db] - Optional database instance for worktree tracking
   */
  constructor(db = null) {
    this.worktreeBaseDir = path.join(getConfigDir(), 'worktrees');
    this.db = db;
    this.worktreeRepo = db ? new WorktreeRepository(db) : null;
  }

  /**
   * Create a git worktree for a PR and checkout to the PR head commit
   * @param {Object} prInfo - PR information { owner, repo, number }
   * @param {Object} prData - PR data from GitHub API
   * @param {string} repositoryPath - Local repository path (main git root)
   * @param {Object} [options] - Optional settings
   * @param {string} [options.worktreeSourcePath] - Path to use as cwd for git worktree add
   *   (to inherit sparse-checkout from an existing worktree). Falls back to repositoryPath.
   * @returns {Promise<string>} Path to created worktree
   */
  async createWorktreeForPR(prInfo, prData, repositoryPath, options = {}) {
    const { worktreeSourcePath } = options;
    // Check if worktree already exists in DB
    const repository = normalizeRepository(prInfo.owner, prInfo.repo);
    let worktreePath;
    let worktreeRecord = null;

    if (this.worktreeRepo) {
      worktreeRecord = await this.worktreeRepo.findByPR(prInfo.number, repository);
    }

    if (worktreeRecord) {
      // Use existing worktree path from DB
      worktreePath = worktreeRecord.path;

      // Check if the directory still exists on disk
      const directoryExists = await this.pathExists(worktreePath);

      if (directoryExists) {
        // Try to reuse existing worktree by refreshing it
        console.log(`Found existing worktree for PR #${prInfo.number} at ${worktreePath}`);
        try {
          return await this.refreshWorktree(worktreeRecord, prInfo.number);
        } catch (refreshError) {
          // If refresh fails due to uncommitted changes, propagate that error
          if (refreshError.message.includes('uncommitted changes')) {
            throw refreshError;
          }
          // For other errors, log and fall through to recreate
          console.log(`Could not refresh existing worktree, will recreate: ${refreshError.message}`);
        }
      } else {
        console.log(`Worktree directory no longer exists at ${worktreePath}, will recreate`);
      }
    } else {
      // Check for legacy worktree before generating new ID
      // Legacy worktrees used naming format: owner-repo-number
      const legacyDirName = `${prInfo.owner}-${prInfo.repo}-${prInfo.number}`;
      const legacyPath = path.join(this.worktreeBaseDir, legacyDirName);
      const legacyExists = await this.pathExists(legacyPath);

      if (legacyExists && await this.isValidGitWorktree(legacyPath)) {
        console.log(`Found legacy worktree for PR #${prInfo.number} at ${legacyPath}, adopting it`);

        // Create DB record for the legacy worktree
        if (this.worktreeRepo) {
          worktreeRecord = await this.worktreeRepo.getOrCreate({
            prNumber: prInfo.number,
            repository,
            branch: prData.head_branch || prData.base_branch,
            path: legacyPath
          });
          console.log(`Created database record for legacy worktree`);
        }

        // Try to refresh and reuse the legacy worktree
        try {
          return await this.refreshWorktree({ path: legacyPath, id: worktreeRecord?.id }, prInfo.number);
        } catch (refreshError) {
          // If refresh fails due to uncommitted changes, propagate that error
          if (refreshError.message.includes('uncommitted changes')) {
            throw refreshError;
          }
          // For other errors, log and fall through to recreate with new ID
          console.log(`Could not refresh legacy worktree, will create new one: ${refreshError.message}`);
        }
      }

      // Generate new random ID for worktree directory
      const worktreeId = generateWorktreeId();
      worktreePath = path.join(this.worktreeBaseDir, worktreeId);
    }

    try {
      console.log(`Creating worktree for PR #${prInfo.number} at ${worktreePath}`);

      // Ensure worktree base directory exists
      await this.ensureWorktreeBaseDir();

      // Clean up existing worktree if it exists
      await this.cleanupWorktree(worktreePath);
      
      // Create git instance for the source repository
      const git = simpleGit(repositoryPath);
      
      // Fetch only the specific base branch we need, with error handling for ref conflicts
      console.log(`Fetching base branch ${prData.base_branch} from origin...`);
      try {
        await git.fetch(['origin', `+refs/heads/${prData.base_branch}:refs/remotes/origin/${prData.base_branch}`]);
      } catch (fetchError) {
        // If fetch fails due to ref conflicts, try alternative approaches
        console.log(`Standard fetch failed, trying alternative: ${fetchError.message}`);
        try {
          // Try fetching with force flag to overwrite conflicting refs
          await git.raw(['fetch', 'origin', `+refs/heads/${prData.base_branch}:refs/remotes/origin/${prData.base_branch}`, '--force']);
        } catch (altFetchError) {
          console.warn(`Could not fetch base branch ${prData.base_branch}, will try to use existing ref`);
          // Continue anyway - the branch might already be available locally
        }
      }
      
      // Create worktree and checkout to base branch
      // Use worktreeSourcePath as cwd if provided (to inherit sparse-checkout from existing worktree)
      const worktreeAddGit = worktreeSourcePath ? simpleGit(worktreeSourcePath) : git;
      if (worktreeSourcePath) {
        console.log(`Creating worktree at ${worktreePath} from ${prData.base_branch} (inheriting sparse-checkout from ${worktreeSourcePath})...`);
      } else {
        console.log(`Creating worktree at ${worktreePath} from ${prData.base_branch}...`);
      }
      try {
        await worktreeAddGit.raw(['worktree', 'add', worktreePath, `origin/${prData.base_branch}`]);
      } catch (worktreeError) {
        // If worktree creation fails due to existing registration, try with --force
        if (worktreeError.message.includes('already registered')) {
          console.log('Worktree already registered, trying with --force...');
          await worktreeAddGit.raw(['worktree', 'add', '--force', worktreePath, `origin/${prData.base_branch}`]);
        } else {
          throw worktreeError;
        }
      }
      
      // Create git instance for the worktree
      const worktreeGit = simpleGit(worktreePath);
      
      // Ensure base SHA is available (in case base branch was force-pushed or rebased)
      console.log(`Ensuring base commit ${prData.base_sha} is available...`);
      try {
        // Try to fetch the specific base SHA if it's not already available
        await worktreeGit.raw(['fetch', 'origin', prData.base_sha]);
      } catch (fetchError) {
        // If fetch fails, the SHA might already be available locally
        console.log(`Base SHA fetch not needed or already available: ${fetchError.message}`);
      }

      // Fetch the PR head using GitHub's pull request refs (more reliable than branch names)
      console.log(`Fetching PR #${prInfo.number} head...`);
      await worktreeGit.fetch(['origin', `+refs/pull/${prInfo.number}/head:refs/remotes/origin/pr-${prInfo.number}`]);

      // Checkout to PR head commit
      console.log(`Checking out to PR head commit ${prData.head_sha}...`);
      await worktreeGit.checkout([`origin/pr-${prInfo.number}`]);
      
      // Verify we're at the correct commit
      const currentCommit = await worktreeGit.revparse(['HEAD']);
      if (currentCommit.trim() !== prData.head_sha) {
        console.warn(`Warning: Expected commit ${prData.head_sha}, but got ${currentCommit.trim()}`);
      }

      // Store/update worktree record in database
      if (this.worktreeRepo) {
        await this.worktreeRepo.getOrCreate({
          prNumber: prInfo.number,
          repository,
          branch: prData.head_branch || prData.base_branch,
          path: worktreePath
        });
        console.log(`Worktree record stored in database`);
      }

      console.log(`Worktree created successfully at ${worktreePath}`);
      return worktreePath;

    } catch (error) {
      console.error('Error creating worktree:', error);
      
      // Clean up on failure
      try {
        await this.cleanupWorktree(worktreePath);
      } catch (cleanupError) {
        console.error('Error during cleanup:', cleanupError);
      }
      
      throw new Error(`Failed to create git worktree: ${error.message}`);
    }
  }

  /**
   * Update an existing worktree with latest PR changes
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {number} number - PR number
   * @param {string} baseRef - Base branch reference
   * @param {string} headSha - Head commit SHA
   * @returns {Promise<string>} Path to updated worktree
   */
  async updateWorktree(owner, repo, number, baseRef, headSha) {
    const prInfo = { owner, repo, number };
    const worktreePath = await this.getWorktreePath(prInfo);

    try {
      // Check if worktree exists
      const exists = await this.worktreeExists(prInfo);
      if (!exists) {
        throw new Error(`Worktree does not exist at ${worktreePath}`);
      }

      console.log(`Updating worktree for PR #${number} at ${worktreePath}`);

      // Create git instance for the worktree
      const worktreeGit = simpleGit(worktreePath);

      // Fetch the latest from origin
      console.log(`Fetching latest changes from origin...`);
      await worktreeGit.fetch(['origin']);

      // Fetch the PR head using GitHub's pull request refs
      console.log(`Fetching PR #${number} head...`);
      await worktreeGit.fetch(['origin', `+refs/pull/${number}/head:refs/remotes/origin/pr-${number}`]);

      // Checkout to PR head commit
      console.log(`Checking out to PR head commit ${headSha}...`);
      await worktreeGit.checkout([`origin/pr-${number}`]);

      // Verify we're at the correct commit
      const currentCommit = await worktreeGit.revparse(['HEAD']);
      if (currentCommit.trim() !== headSha) {
        console.warn(`Warning: Expected commit ${headSha}, but got ${currentCommit.trim()}`);
      }

      console.log(`Worktree updated successfully at ${worktreePath}`);
      return worktreePath;

    } catch (error) {
      console.error('Error updating worktree:', error);
      throw new Error(`Failed to update git worktree: ${error.message}`);
    }
  }

  /**
   * Generate unified diff between base and head branches
   * @param {string} worktreePath - Path to worktree
   * @param {Object} prData - PR data from GitHub API
   * @returns {Promise<string>} Unified diff content
   */
  async generateUnifiedDiff(worktreePath, prData) {
    try {
      console.log(`Generating diff between ${prData.base_sha} and ${prData.head_sha}...`);

      const git = simpleGit(worktreePath);

      // Generate diff between base SHA and head SHA (not branch names)
      // This ensures we compare the exact commits from the PR, even if the base branch has moved
      const diff = await git.diff([
        `${prData.base_sha}...${prData.head_sha}`,
        '--unified=3'
      ]);

      return diff;

    } catch (error) {
      console.error('Error generating diff:', error);
      throw new Error(`Failed to generate diff: ${error.message}`);
    }
  }

  /**
   * Get list of changed files in the PR
   * @param {string} worktreePath - Path to worktree
   * @param {Object} prData - PR data from GitHub API
   * @returns {Promise<Array>} Array of changed file information
   */
  async getChangedFiles(worktreePath, prData) {
    try {
      const git = simpleGit(worktreePath);

      // Get file changes with stats using base SHA and head SHA
      // This ensures we get the exact files changed in the PR, even if the base branch has moved
      const diffSummary = await git.diffSummary([`${prData.base_sha}...${prData.head_sha}`]);

      // Parse .gitattributes to identify generated files
      const gitattributes = await getGeneratedFilePatterns(worktreePath);

      return diffSummary.files.map(file => {
        const resolvedFile = resolveRenamedFile(file.file);
        const isRenamed = resolvedFile !== file.file;
        const result = {
          file: resolvedFile,
          insertions: file.insertions,
          deletions: file.deletions,
          changes: file.changes,
          binary: file.binary || false,
          generated: gitattributes.isGenerated(resolvedFile)
        };
        if (isRenamed) {
          result.renamed = true;
          result.renamedFrom = resolveRenamedFileOld(file.file);
        }
        return result;
      });

    } catch (error) {
      console.error('Error getting changed files:', error);
      throw new Error(`Failed to get changed files: ${error.message}`);
    }
  }

  /**
   * Get worktree path for a PR
   * Looks up path from database if available, otherwise falls back to legacy naming
   * @param {Object} prInfo - PR information { owner, repo, number }
   * @returns {Promise<string>} Worktree path
   */
  async getWorktreePath(prInfo) {
    // Try to look up from database first
    if (this.worktreeRepo) {
      const repository = normalizeRepository(prInfo.owner, prInfo.repo);
      const record = await this.worktreeRepo.findByPR(prInfo.number, repository);
      if (record) {
        return record.path;
      }
    }

    // Fallback to legacy naming for backwards compatibility
    // This handles worktrees created before random ID implementation
    const dirName = `${prInfo.owner}-${prInfo.repo}-${prInfo.number}`;
    return path.join(this.worktreeBaseDir, dirName);
  }

  /**
   * Check if worktree exists for a PR
   * @param {Object} prInfo - PR information { owner, repo, number }
   * @returns {Promise<boolean>} Whether worktree exists
   */
  async worktreeExists(prInfo) {
    const worktreePath = await this.getWorktreePath(prInfo);
    
    try {
      const stat = await fs.stat(worktreePath);
      return stat.isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Cleanup a specific worktree
   * @param {string} worktreePath - Path to worktree to cleanup
   * @returns {Promise<void>}
   */
  async cleanupWorktree(worktreePath) {
    try {
      // First try to prune any stale worktree registrations
      await this.pruneWorktrees();
      
      // Check if worktree exists
      const exists = await this.pathExists(worktreePath);
      
      // Try to remove via git worktree remove first (handles both directory and registration)
      try {
        const parentGit = simpleGit(path.dirname(worktreePath));
        await parentGit.raw(['worktree', 'remove', '--force', worktreePath]);
        console.log(`Removed worktree via git: ${worktreePath}`);
        return;
      } catch (gitError) {
        console.log('Git worktree remove failed, trying manual cleanup...');
      }

      // If directory exists, remove it manually
      if (exists) {
        await this.removeDirectory(worktreePath);
        console.log(`Removed worktree directory: ${worktreePath}`);
      }
      
    } catch (error) {
      console.warn(`Warning: Could not cleanup worktree at ${worktreePath}: ${error.message}`);
      // Don't throw - this is cleanup, continue with creation
    }
  }

  /**
   * Cleanup all worktrees for a repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<void>}
   */
  async cleanupRepositoryWorktrees(owner, repo) {
    try {
      const pattern = `${owner}-${repo}-*`;
      const worktrees = await this.findWorktreesByPattern(pattern);
      
      for (const worktreePath of worktrees) {
        await this.cleanupWorktree(worktreePath);
      }
      
    } catch (error) {
      console.warn(`Warning: Could not cleanup repository worktrees: ${error.message}`);
    }
  }

  /**
   * Ensure worktree base directory exists
   * @returns {Promise<void>}
   */
  async ensureWorktreeBaseDir() {
    try {
      await fs.mkdir(this.worktreeBaseDir, { recursive: true });
    } catch (error) {
      throw new Error(`Could not create worktree directory ${this.worktreeBaseDir}: ${error.message}`);
    }
  }

  /**
   * Check if path exists
   * @param {string} path - Path to check
   * @returns {Promise<boolean>} Whether path exists
   */
  async pathExists(path) {
    try {
      await fs.access(path);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a directory is a valid git worktree
   * @param {string} dirPath - Directory path to check
   * @returns {Promise<boolean>} Whether directory is a valid git worktree
   */
  async isValidGitWorktree(dirPath) {
    try {
      // A git worktree has a .git file (not directory) that points to the main repo
      const gitPath = path.join(dirPath, '.git');
      const stat = await fs.stat(gitPath);

      // In a worktree, .git is a file containing "gitdir: <path>"
      // In a regular repo, .git is a directory
      if (stat.isFile()) {
        // Verify it's actually a git repo by trying to get the HEAD
        const git = simpleGit(dirPath);
        await git.revparse(['HEAD']);
        return true;
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Remove directory recursively
   * @param {string} dirPath - Directory path to remove
   * @returns {Promise<void>}
   */
  async removeDirectory(dirPath) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      // Fallback for older Node.js versions
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        execSync(`rmdir /s /q "${dirPath}"`, { stdio: 'ignore' });
      } else {
        execSync(`rm -rf "${dirPath}"`, { stdio: 'ignore' });
      }
    }
  }

  /**
   * Find worktrees matching a pattern
   * @param {string} pattern - Pattern to match (e.g., "owner-repo-*")
   * @returns {Promise<Array<string>>} Array of matching worktree paths
   */
  async findWorktreesByPattern(pattern) {
    try {
      const exists = await this.pathExists(this.worktreeBaseDir);
      if (!exists) {
        return [];
      }

      const entries = await fs.readdir(this.worktreeBaseDir);
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      
      return entries
        .filter(entry => regex.test(entry))
        .map(entry => path.join(this.worktreeBaseDir, entry));
        
    } catch (error) {
      console.warn(`Warning: Could not find worktrees by pattern: ${error.message}`);
      return [];
    }
  }

  /**
   * Prune stale worktree registrations
   * @returns {Promise<void>}
   */
  async pruneWorktrees() {
    try {
      // Find the parent git repository to prune from
      // We need to find any git repo to run the prune command
      const git = simpleGit(process.cwd());
      await git.raw(['worktree', 'prune']);
      console.log('Pruned stale worktree registrations');
    } catch (error) {
      console.log('Could not prune worktrees (this is normal if not in a git repo):', error.message);
    }
  }

  /**
   * Check if a worktree has uncommitted local changes
   * @param {string} worktreePath - Path to worktree
   * @returns {Promise<boolean>} True if there are uncommitted changes
   */
  async hasLocalChanges(worktreePath) {
    try {
      const git = simpleGit(worktreePath);
      const status = await git.raw(['status', '--porcelain']);
      return status.trim().length > 0;
    } catch (error) {
      console.error('Error checking for local changes:', error);
      throw new Error(`Failed to check for local changes: ${error.message}`);
    }
  }

  /**
   * Refresh an existing worktree with latest PR changes from remote
   * @param {Object} worktreeRecord - Database record for the worktree
   * @param {number} prNumber - PR number to refresh
   * @returns {Promise<string>} Path to the refreshed worktree
   * @throws {Error} If worktree has uncommitted changes
   */
  async refreshWorktree(worktreeRecord, prNumber) {
    const worktreePath = worktreeRecord.path;

    try {
      console.log(`Refreshing existing worktree for PR #${prNumber} at ${worktreePath}`);

      // Check for uncommitted changes
      const hasChanges = await this.hasLocalChanges(worktreePath);
      if (hasChanges) {
        throw new Error(`Worktree has uncommitted changes. Please resolve manually at: ${worktreePath}`);
      }

      const git = simpleGit(worktreePath);

      // Fetch the latest PR head from remote
      console.log(`Fetching PR #${prNumber} head from remote...`);
      await git.fetch(['origin', `pull/${prNumber}/head`]);

      // Reset to the fetched PR head
      console.log(`Resetting worktree to PR head...`);
      await git.raw(['reset', '--hard', 'FETCH_HEAD']);

      // Update last_accessed_at in database
      if (this.worktreeRepo) {
        await this.worktreeRepo.updateLastAccessed(worktreeRecord.id);
        console.log(`Updated last_accessed_at timestamp for worktree`);
      }

      console.log(`Worktree refreshed successfully at ${worktreePath}`);
      return worktreePath;

    } catch (error) {
      // Re-throw errors about uncommitted changes as-is
      if (error.message.includes('uncommitted changes')) {
        throw error;
      }
      console.error('Error refreshing worktree:', error);
      throw new Error(`Failed to refresh worktree: ${error.message}`);
    }
  }

  /**
   * Cleanup stale worktrees that haven't been accessed within the retention period
   * @param {number} retentionDays - Number of days to retain worktrees (default: 7)
   * @returns {Promise<Object>} Cleanup result with count and details
   */
  async cleanupStaleWorktrees(retentionDays = 7) {
    const result = {
      cleaned: 0,
      failed: 0,
      errors: []
    };

    if (!this.worktreeRepo) {
      console.log('[pair-review] No database connection, skipping stale worktree cleanup');
      return result;
    }

    try {
      // Calculate the cutoff date
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      // Find stale worktrees from database
      const staleWorktrees = await this.worktreeRepo.findStale(cutoffDate);

      if (staleWorktrees.length === 0) {
        return result;
      }

      console.log(`[pair-review] Found ${staleWorktrees.length} stale worktrees older than ${retentionDays} days`);

      for (const worktree of staleWorktrees) {
        try {
          // Try to remove via git worktree remove first
          try {
            const git = simpleGit(path.dirname(worktree.path));
            await git.raw(['worktree', 'remove', '--force', worktree.path]);
            console.log(`[pair-review] Removed worktree via git: ${worktree.path}`);
          } catch (gitError) {
            // If git worktree remove fails, try manual directory removal
            const exists = await this.pathExists(worktree.path);
            if (exists) {
              await this.removeDirectory(worktree.path);
              console.log(`[pair-review] Removed worktree directory manually: ${worktree.path}`);
            }
          }

          // Delete the database record
          await this.worktreeRepo.delete(worktree.id);
          result.cleaned++;

        } catch (error) {
          result.failed++;
          result.errors.push({
            id: worktree.id,
            path: worktree.path,
            error: error.message
          });
          console.warn(`[pair-review] Failed to cleanup worktree ${worktree.id}: ${error.message}`);
        }
      }

      // Run git worktree prune to clean up orphaned registrations
      await this.pruneWorktrees();

      if (result.cleaned > 0) {
        console.log(`[pair-review] Cleaned up ${result.cleaned} stale worktrees (older than ${retentionDays} days)`);
      }

    } catch (error) {
      console.error('[pair-review] Error during stale worktree cleanup:', error.message);
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Get worktree information
   * @param {string} worktreePath - Path to worktree
   * @returns {Promise<Object>} Worktree information
   */
  async getWorktreeInfo(worktreePath) {
    try {
      const git = simpleGit(worktreePath);
      const currentBranch = await git.branch();
      const currentCommit = await git.revparse(['HEAD']);
      
      return {
        path: worktreePath,
        branch: currentBranch.current,
        commit: currentCommit.trim(),
        exists: await this.pathExists(worktreePath)
      };
      
    } catch (error) {
      return {
        path: worktreePath,
        branch: null,
        commit: null,
        exists: false,
        error: error.message
      };
    }
  }

  /**
   * Check if sparse-checkout is enabled for a git repository
   * @param {string} repoPath - Path to the git repository or worktree
   * @returns {Promise<boolean>} Whether sparse-checkout is enabled
   */
  async isSparseCheckoutEnabled(repoPath) {
    try {
      const git = simpleGit(repoPath);
      const config = await git.raw(['config', 'core.sparseCheckout']);
      return config.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Get current sparse-checkout patterns
   * @param {string} repoPath - Path to the git repository or worktree
   * @returns {Promise<string[]>} Array of sparse-checkout patterns
   */
  async getSparseCheckoutPatterns(repoPath) {
    try {
      const git = simpleGit(repoPath);
      const output = await git.raw(['sparse-checkout', 'list']);
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Ensure all directories containing changed files are in sparse-checkout.
   * Finds the minimal set of directories to add.
   *
   * @param {string} worktreePath - Path to the worktree
   * @param {Array} changedFiles - Array of changed file objects with filename or file property
   * @returns {Promise<string[]>} Directories that were added
   */
  async ensurePRDirectoriesInSparseCheckout(worktreePath, changedFiles) {
    if (!await this.isSparseCheckoutEnabled(worktreePath)) {
      return [];
    }

    const currentPatterns = await this.getSparseCheckoutPatterns(worktreePath);

    // Extract unique directory paths from changed files
    // Support both {filename} and {file} properties
    const neededDirs = new Set();
    for (const file of changedFiles) {
      const filename = file.filename || file.file;
      if (!filename) continue;
      // Add only the immediate parent directory of the file.
      // Root-level files (no '/') are skipped — cone mode always includes the repo root.
      const lastSlash = filename.lastIndexOf('/');
      if (lastSlash > 0) {
        neededDirs.add(filename.substring(0, lastSlash));
      }
    }

    // Find directories not covered by current patterns.
    // NOTE: This uses startsWith() for directory-based comparison, which only
    // supports cone mode (directory path patterns). Glob-based sparse-checkout
    // patterns (e.g., '*.js', '**/test/') would not be matched correctly.
    // This is acceptable for now since we only support cone mode throughout
    // the worktree implementation. See tech debt tracking for glob support.
    const missingDirs = [...neededDirs].filter(dir => {
      // Check if dir is already covered by an existing pattern
      return !currentPatterns.some(pattern => {
        // Covered if: exact match or dir is inside pattern (pattern is parent).
        // Note: we do NOT check pattern.startsWith(dir + '/') because a child
        // pattern (e.g., 'packages/core') does not cover files directly under
        // the parent directory (e.g., 'packages/package.json').
        return dir === pattern ||
               dir.startsWith(pattern + '/');
      });
    });

    // Find minimal set (remove dirs whose parents are also in missingDirs)
    const minimalDirs = missingDirs.filter(dir => {
      return !missingDirs.some(other =>
        other !== dir && dir.startsWith(other + '/')
      );
    });

    if (minimalDirs.length > 0) {
      const git = simpleGit(worktreePath);
      await git.raw(['sparse-checkout', 'add', ...minimalDirs]);
    }

    return minimalDirs;
  }
}

module.exports = { GitWorktreeManager };