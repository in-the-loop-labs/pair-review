// SPDX-License-Identifier: GPL-3.0-or-later
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
    const result = this.parsePRUrl(input);

    if (result) {
      return result;
    }

    // Check if input is a PR number
    const prNumber = parseInt(input);
    if (isNaN(prNumber) || prNumber <= 0) {
      throw new Error('Invalid input format. Expected: PR number, GitHub URL (https://github.com/owner/repo/pull/number), or Graphite URL (https://app.graphite.com/github/pr/owner/repo/number)');
    }

    // Parse repository from current directory's git remote
    const { owner, repo } = await this.parseRepositoryFromGitRemote();
    return { owner, repo, number: prNumber };
  }

  /**
   * Parse a PR URL string and extract owner, repo, and PR number
   * Handles both GitHub and Graphite URLs, with or without protocol
   * @param {string} url - The PR URL to parse
   * @returns {Object|null} { owner, repo, number } or null if not a valid PR URL
   */
  parsePRUrl(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    // Clean up the URL - trim whitespace
    let normalizedUrl = url.trim();

    // Add https:// if no protocol is present
    if (normalizedUrl.startsWith('github.com')) {
      normalizedUrl = 'https://' + normalizedUrl;
    } else if (normalizedUrl.startsWith('app.graphite.dev') || normalizedUrl.startsWith('app.graphite.com')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    // Check if input is a GitHub URL
    if (normalizedUrl.startsWith('https://github.com/')) {
      try {
        return this.parseGitHubURL(normalizedUrl);
      } catch (e) {
        return null;
      }
    }

    // Check if input is a Graphite URL
    if (normalizedUrl.startsWith('https://app.graphite.dev/') || normalizedUrl.startsWith('https://app.graphite.com/')) {
      try {
        return this.parseGraphiteURL(normalizedUrl);
      } catch (e) {
        return null;
      }
    }

    return null;
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
    return this._createPRInfo(owner, repo, numberStr, 'GitHub');
  }

  /**
   * Parse Graphite URL to extract owner, repo, and PR number
   * @param {string} url - Graphite pull request URL
   * @returns {Object} Parsed information { owner, repo, number }
   */
  parseGraphiteURL(url) {
    // Match Graphite PR URL pattern: https://app.graphite.{dev|com}/github/pr/owner/repo/number[/optional-title]
    const match = url.match(/^https:\/\/app\.graphite\.(?:dev|com)\/github\/pr\/([^\/]+)\/([^\/]+)\/(\d+)(?:\/.*)?$/);

    if (!match) {
      throw new Error('Invalid Graphite URL format. Expected: https://app.graphite.com/github/pr/owner/repo/number');
    }

    const [, owner, repo, numberStr] = match;
    return this._createPRInfo(owner, repo, numberStr, 'Graphite');
  }

  /**
   * Create and validate PR info object from parsed components
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} numberStr - PR number as string
   * @param {string} source - Source name for error messages ('GitHub' or 'Graphite')
   * @returns {Object} Validated PR info { owner, repo, number }
   * @private
   */
  _createPRInfo(owner, repo, numberStr, source) {
    const number = parseInt(numberStr);

    if (isNaN(number) || number <= 0) {
      const exampleUrl = source === 'GitHub'
        ? 'https://github.com/owner/repo/pull/number'
        : 'https://app.graphite.com/github/pr/owner/repo/number';
      throw new Error(`Invalid ${source} URL format. Expected: ${exampleUrl}`);
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