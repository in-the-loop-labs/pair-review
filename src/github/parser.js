const simpleGit = require('simple-git');
const path = require('path');

/**
 * Parse command line arguments to extract PR information
 */
class PRArgumentParser {
  constructor() {
    this.git = simpleGit();
  }

  /**
   * Parse PR arguments from command line
   * @param {Array<string>} args - Command line arguments
   * @returns {Promise<Object>} Parsed PR information { owner, repo, number }
   */
  async parsePRArguments(args) {
    if (args.length === 0) {
      throw new Error('Pull request number or URL is required. Usage: npx pair-review <PR-number> or npx pair-review <GitHub-URL>');
    }

    const input = args[0];

    // Check if input is a GitHub URL
    if (input.startsWith('https://github.com/')) {
      return this.parseGitHubURL(input);
    }

    // Check if input is a PR number
    const prNumber = parseInt(input);
    if (isNaN(prNumber) || prNumber <= 0) {
      throw new Error('Invalid GitHub URL format. Expected: https://github.com/owner/repo/pull/number');
    }

    // Parse repository from current directory's git remote
    const { owner, repo } = await this.parseRepositoryFromGitRemote();
    return { owner, repo, number: prNumber };
  }

  /**
   * Parse GitHub URL to extract owner, repo, and PR number
   * @param {string} url - GitHub pull request URL
   * @returns {Object} Parsed information { owner, repo, number }
   */
  parseGitHubURL(url) {
    // Match GitHub PR URL pattern: https://github.com/owner/repo/pull/number
    const match = url.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)(?:\/.*)?$/);
    
    if (!match) {
      throw new Error('Invalid GitHub URL format. Expected: https://github.com/owner/repo/pull/number');
    }

    const [, owner, repo, numberStr] = match;
    const number = parseInt(numberStr);

    if (isNaN(number) || number <= 0) {
      throw new Error('Invalid GitHub URL format. Expected: https://github.com/owner/repo/pull/number');
    }

    return { owner, repo, number };
  }

  /**
   * Parse repository owner and name from git remote origin URL
   * @returns {Promise<Object>} Repository information { owner, repo }
   */
  async parseRepositoryFromGitRemote() {
    try {
      // Check if we're in a git repository
      const isRepo = await this.git.checkIsRepo();
      if (!isRepo) {
        throw new Error('Current directory is not a git repository or has no GitHub remote origin');
      }

      // Get remote origin URL
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find(remote => remote.name === 'origin');
      
      if (!origin) {
        throw new Error('Current directory is not a git repository or has no GitHub remote origin');
      }

      const remoteUrl = origin.refs.fetch || origin.refs.push;
      if (!remoteUrl) {
        throw new Error('Current directory is not a git repository or has no GitHub remote origin');
      }

      return this.parseRepositoryFromURL(remoteUrl);
    } catch (error) {
      if (error.message.includes('not a git repository') || error.message.includes('Not a git repository')) {
        throw new Error('Current directory is not a git repository or has no GitHub remote origin');
      }
      throw error;
    }
  }

  /**
   * Parse repository owner and name from various Git URL formats
   * @param {string} url - Git remote URL (HTTPS or SSH)
   * @returns {Object} Repository information { owner, repo }
   */
  parseRepositoryFromURL(url) {
    // Handle HTTPS URLs: https://github.com/owner/repo.git
    let match = url.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }

    // Handle SSH URLs: git@github.com:owner/repo.git
    match = url.match(/^git@github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }

    throw new Error('Current directory is not a git repository or has no GitHub remote origin');
  }

  /**
   * Validate PR arguments
   * @param {Object} prInfo - PR information { owner, repo, number }
   * @throws {Error} If arguments are invalid
   */
  validatePRArguments(prInfo) {
    if (!prInfo.owner || typeof prInfo.owner !== 'string' || prInfo.owner.trim().length === 0) {
      throw new Error('Invalid repository owner');
    }

    if (!prInfo.repo || typeof prInfo.repo !== 'string' || prInfo.repo.trim().length === 0) {
      throw new Error('Invalid repository name');
    }

    if (!prInfo.number || typeof prInfo.number !== 'number' || prInfo.number <= 0) {
      throw new Error('Invalid pull request number');
    }
  }

  /**
   * Get current working directory path
   * @returns {string} Current working directory
   */
  getCurrentDirectory() {
    return process.cwd();
  }

  /**
   * Check if current directory is a git repository
   * @returns {Promise<boolean>} Whether current directory is a git repo
   */
  async isGitRepository() {
    try {
      return await this.git.checkIsRepo();
    } catch (error) {
      return false;
    }
  }

  /**
   * Get git repository root directory
   * @returns {Promise<string>} Git repository root path
   */
  async getRepositoryRoot() {
    try {
      const revParseResult = await this.git.revparse(['--show-toplevel']);
      return revParseResult.trim();
    } catch (error) {
      throw new Error('Current directory is not a git repository or has no GitHub remote origin');
    }
  }
}

module.exports = { PRArgumentParser };