const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { getConfigDir } = require('../config');

/**
 * Git worktree manager for handling PR branch checkouts and diffs
 */
class GitWorktreeManager {
  constructor() {
    this.worktreeBaseDir = path.join(getConfigDir(), 'worktrees');
  }

  /**
   * Create a git worktree for a PR and checkout to the PR head commit
   * @param {Object} prInfo - PR information { owner, repo, number }
   * @param {Object} prData - PR data from GitHub API
   * @param {string} repositoryPath - Local repository path
   * @returns {Promise<string>} Path to created worktree
   */
  async createWorktreeForPR(prInfo, prData, repositoryPath) {
    const worktreePath = await this.getWorktreePath(prInfo);
    
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
      console.log(`Creating worktree at ${worktreePath} from ${prData.base_branch}...`);
      try {
        await git.raw(['worktree', 'add', worktreePath, `origin/${prData.base_branch}`]);
      } catch (worktreeError) {
        // If worktree creation fails due to existing registration, try with --force
        if (worktreeError.message.includes('already registered')) {
          console.log('Worktree already registered, trying with --force...');
          await git.raw(['worktree', 'add', '--force', worktreePath, `origin/${prData.base_branch}`]);
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

      return diffSummary.files.map(file => ({
        file: file.file,
        insertions: file.insertions,
        deletions: file.deletions,
        changes: file.changes,
        binary: file.binary || false
      }));

    } catch (error) {
      console.error('Error getting changed files:', error);
      throw new Error(`Failed to get changed files: ${error.message}`);
    }
  }

  /**
   * Get worktree path for a PR
   * @param {Object} prInfo - PR information { owner, repo, number }
   * @returns {Promise<string>} Worktree path
   */
  async getWorktreePath(prInfo) {
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
}

module.exports = { GitWorktreeManager };