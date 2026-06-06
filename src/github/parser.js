// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const simpleGit = require('simple-git');
const path = require('path');
const { matchRepoByUrl } = require('../config');

/**
 * Parse command line arguments to extract PR information
 */
class PRArgumentParser {
  /**
   * @param {Object} [config] - Optional pair-review config. When provided,
   *   per-repo `url_pattern` regexes are tried before the built-in GitHub
   *   and Graphite URL parsers, allowing pasted URLs from alternate hosts
   *   to be resolved to the correct repo entry. The canonical
   *   `owner/repo` from the config key (or named capture groups) takes
   *   precedence over any host-specific parsing.
   */
  constructor(config = null) {
    this.git = simpleGit();
    this.config = config;
  }

  /**
   * Parse PR arguments from command line.
   *
   * Returns at minimum `{ owner, repo, number }`. When the input was
   * matched against a per-repo `url_pattern`, the returned object also
   * includes `bindingRepository` — the `repos[...]` config key that was
   * matched. Callers performing a host-binding lookup should prefer
   * `bindingRepository` over `${owner}/${repo}` so monorepo-style configs
   * where the URL pattern matches multiple sub-repos resolve to the
   * correct entry. When `bindingRepository` is absent, callers should
   * fall back to `${owner}/${repo}`.
   *
   * @param {Array<string>} args - Command line arguments
   * @returns {Promise<{owner: string, repo: string, number: number, bindingRepository?: string}>}
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
      throw new Error('Invalid input format. Expected: PR number, GitHub URL (https://github.com/owner/repo/pull/number), Graphite URL (https://app.graphite.com/github/pr/owner/repo/number or https://app.graphite.com/github/owner/repo/pull/number), or pair-review:// URL');
    }

    // Parse repository from current directory's git remote
    const { owner, repo } = await this.parseRepositoryFromGitRemote();
    return { owner, repo, number: prNumber };
  }

  /**
   * Match a URL against any configured `url_pattern` regex in the repos
   * config. Returns `{ owner, repo, number, bindingRepository }` when a
   * match yields a complete triple (owner+repo+number), otherwise null.
   * Used to resolve URLs pasted from alternate Git hosts before falling
   * back to the built-in GitHub/Graphite parsers.
   *
   * `bindingRepository` is the matched `repos[...]` config key — use it
   * to look up the host binding (token, api_host, features) when the
   * captured owner/repo differ from the config key.
   *
   * @param {string} url - The URL to match
   * @returns {Object|null} `{ owner, repo, number, bindingRepository }` or null
   * @private
   */
  _matchUrlPatternFromConfig(url) {
    if (!this.config) return null;
    const match = matchRepoByUrl(url, this.config);
    if (!match) return null;

    // Derive owner/repo: prefer named capture groups, fall back to the
    // canonical "owner/repo" repository key from config.
    let { owner, repo, number } = match;
    if ((!owner || !repo) && match.repository && match.repository.includes('/')) {
      const [keyOwner, keyRepo] = match.repository.split('/');
      if (!owner) owner = keyOwner;
      if (!repo) repo = keyRepo;
    }

    if (!owner || !repo || typeof number !== 'number' || isNaN(number) || number <= 0) {
      return null;
    }
    return {
      owner,
      repo,
      number,
      bindingRepository: match.bindingRepository
    };
  }

  /**
   * Parse a PR URL string and extract owner, repo, and PR number
   * Handles both GitHub and Graphite URLs, with or without protocol.
   *
   * When the parser was constructed with a config, per-repo `url_pattern`
   * regexes are tried first so that alternate-host URLs resolve to the
   * canonical owner/repo from config.
   *
   * @param {string} url - The PR URL to parse
   * @returns {Object|null} { owner, repo, number } or null if not a valid PR URL
   */
  parsePRUrl(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    // Try config-driven URL pattern matching first. This handles
    // alternate-host URLs and lets host-specific repos override the
    // built-in github.com path if they choose.
    const configMatch = this._matchUrlPatternFromConfig(url.trim());
    if (configMatch) {
      return configMatch;
    }

    // Clean up the URL - trim whitespace
    let normalizedUrl = url.trim();

    // Add https:// if no protocol is present
    if (normalizedUrl.startsWith('github.com')) {
      normalizedUrl = 'https://' + normalizedUrl;
    } else if (normalizedUrl.startsWith('app.graphite.dev') || normalizedUrl.startsWith('app.graphite.com')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    // Check if input is a pair-review:// protocol URL
    if (normalizedUrl.startsWith('pair-review://')) {
      try {
        return this.parseProtocolURL(normalizedUrl);
      } catch (e) {
        return null;
      }
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
    // Match Graphite PR URL patterns:
    //   https://app.graphite.{dev|com}/github/pr/owner/repo/number[/optional-title]
    //   https://app.graphite.{dev|com}/github/owner/repo/pull/number[/optional-title]
    const match = url.match(/^https:\/\/app\.graphite\.(?:dev|com)\/github\/(?:pr\/([^\/]+)\/([^\/]+)\/(\d+)|([^\/]+)\/([^\/]+)\/pull\/(\d+))(?:\/[^?]*)?(?:\?.*)?$/);

    if (!match) {
      throw new Error('Invalid Graphite URL format. Expected: https://app.graphite.com/github/pr/owner/repo/number or https://app.graphite.com/github/owner/repo/pull/number');
    }

    const owner = match[1] || match[4];
    const repo = match[2] || match[5];
    const numberStr = match[3] || match[6];
    return this._createPRInfo(owner, repo, numberStr, 'Graphite');
  }

  /**
   * Parse pair-review:// protocol URL to extract owner, repo, and PR number
   * @param {string} url - Protocol URL (e.g., pair-review://pr/owner/repo/123)
   * @returns {Object} Parsed information { owner, repo, number }
   */
  parseProtocolURL(url) {
    const match = url.match(/^pair-review:\/\/pr\/([^\/]+)\/([^\/]+)\/(\d+)(?:\/.*)?$/);

    if (!match) {
      throw new Error('Invalid pair-review:// URL format. Expected: pair-review://pr/owner/repo/number');
    }

    const [, owner, repo, numberStr] = match;
    return this._createPRInfo(owner, repo, numberStr, 'pair-review://');
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
        : source === 'pair-review://'
          ? 'pair-review://pr/owner/repo/number'
          : 'https://app.graphite.com/github/pr/owner/repo/number or https://app.graphite.com/github/owner/repo/pull/number';
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

    // Fall through to config-driven alt-host matching. Only consulted
    // when the built-in github.com patterns don't match, so common-case
    // github.com behaviour is unchanged. Requires the parser to have
    // been constructed with a config; otherwise short-circuits and
    // throws.
    const altHostMatch = this._parseAltHostRepositoryFromURL(url);
    if (altHostMatch) {
      return altHostMatch;
    }

    throw new Error('Current directory is not a git repository or has no GitHub remote origin');
  }

  /**
   * Try to resolve a non-github.com git remote URL to a configured repo
   * entry. Walks `this.config.repos` looking for entries that declare an
   * `api_host` (alt-host repos) and matches the URL against patterns
   * derived from that host + the canonical "owner/repo" config key.
   *
   * Match order per repo entry:
   *   1. The optional `git_remote_pattern` escape hatch (a regex string).
   *      When present, it is tried FIRST so users with non-standard
   *      remote URL layouts can opt in. If the regex matches anywhere
   *      in the remote URL, the canonical config key is returned.
   *   2. Patterns derived from `api_host` + canonical "owner/repo" key:
   *        - `https://<host>/<owner>/<repo>(.git)?`
   *        - `http://<host>/<owner>/<repo>(.git)?`  (for self-hosted dev)
   *        - `git@<host>:<owner>/<repo>(.git)?`
   *      The host portion of `api_host` is used as-is for HTTP(S)
   *      patterns (it may already include a scheme/port — we strip the
   *      scheme to derive the bare host for the SSH form).
   *
   * First match wins; the canonical "owner/repo" from the config KEY is
   * returned (named groups in `git_remote_pattern` are not consulted —
   * the contract is "if the regex matches the URL, the repo entry
   * applies").
   *
   * Returns null when no entry matches (or when no config is available),
   * letting the caller fall through to its existing error path.
   *
   * @param {string} url - Git remote URL
   * @returns {Object|null} { owner, repo } or null
   * @private
   */
  _parseAltHostRepositoryFromURL(url) {
    if (!url || typeof url !== 'string') return null;
    if (!this.config || !this.config.repos || typeof this.config.repos !== 'object') {
      return null;
    }

    for (const [repoKey, repoEntry] of Object.entries(this.config.repos)) {
      if (!repoEntry || typeof repoEntry !== 'object') continue;
      const apiHost = (typeof repoEntry.api_host === 'string' && repoEntry.api_host)
        ? repoEntry.api_host
        : null;
      // Only alt-host repos participate here. github.com repos take the
      // built-in fast path above.
      if (!apiHost) continue;

      // 1. Escape hatch: per-repo git_remote_pattern. We treat it as a
      //    regex (consistent with the existing url_pattern field) and
      //    use RegExp#test so callers can omit `^` if they want a
      //    substring-style match. validateRepoConfig() rejects invalid
      //    regexes at startup; the try/catch here is purely defensive.
      const remotePattern = repoEntry.git_remote_pattern;
      if (typeof remotePattern === 'string' && remotePattern) {
        try {
          if (new RegExp(remotePattern).test(url)) {
            const parts = this._splitRepoKey(repoKey);
            if (parts) return parts;
          }
        } catch {
          // Invalid regex — would have been caught at startup; skip.
        }
      }

      const parts = this._splitRepoKey(repoKey);
      if (!parts) continue;

      // 2. Derive HTTPS/HTTP/SSH patterns from api_host. api_host may
      //    already include a scheme (and possibly a port + path like
      //    "https://althost.example/api/v3"). Strip the scheme to get
      //    the bare host[:port] that appears in git remote URLs.
      const bareHost = this._bareHostFromApiHost(apiHost);
      if (!bareHost) continue;

      const escapedHost = this._escapeRegex(bareHost);
      const escapedOwner = this._escapeRegex(parts.owner);
      const escapedRepo = this._escapeRegex(parts.repo);

      // Allow either https:// or http:// scheme (self-hosted dev
      // instances sometimes use plain HTTP). Tolerate optional .git
      // suffix. Anchored to start/end so we don't accidentally match
      // a substring inside a different host's URL.
      const httpRegex = new RegExp(
        `^https?:\\/\\/${escapedHost}\\/${escapedOwner}\\/${escapedRepo}(?:\\.git)?$`,
        'i'
      );
      if (httpRegex.test(url)) return parts;

      const sshRegex = new RegExp(
        `^git@${escapedHost}:${escapedOwner}\\/${escapedRepo}(?:\\.git)?$`,
        'i'
      );
      if (sshRegex.test(url)) return parts;
    }

    return null;
  }

  /**
   * Strip a scheme (and any trailing path) off an `api_host` config
   * value to derive the bare host[:port] string that appears in a git
   * remote URL. `api_host` is conventionally something like
   * `https://althost.example/api/v3`, but bare `althost.example` is
   * also accepted.
   *
   * @param {string} apiHost
   * @returns {string|null} - Host[:port] or null when the value is unusable
   * @private
   */
  _bareHostFromApiHost(apiHost) {
    if (typeof apiHost !== 'string' || !apiHost) return null;
    // Strip scheme if present.
    let host = apiHost.replace(/^https?:\/\//i, '');
    // Strip everything from the first slash onward (path component).
    const slashIdx = host.indexOf('/');
    if (slashIdx >= 0) host = host.slice(0, slashIdx);
    return host || null;
  }

  /**
   * Split a canonical "owner/repo" config key into { owner, repo }.
   * Returns null when the key is malformed.
   *
   * @param {string} repoKey
   * @returns {{owner: string, repo: string}|null}
   * @private
   */
  _splitRepoKey(repoKey) {
    if (typeof repoKey !== 'string') return null;
    const idx = repoKey.indexOf('/');
    if (idx <= 0 || idx === repoKey.length - 1) return null;
    return { owner: repoKey.slice(0, idx), repo: repoKey.slice(idx + 1) };
  }

  /**
   * Escape a string for safe embedding inside a regex literal.
   * @param {string} s
   * @returns {string}
   * @private
   */
  _escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
   * Check if a directory is a git repository that matches the specified owner/repo.
   * Compares the git remote origin URL against the expected owner/repo.
   *
   * @param {string} directory - Directory path to check
   * @param {string} expectedOwner - Expected repository owner
   * @param {string} expectedRepo - Expected repository name
   * @returns {Promise<boolean>} True if the directory is a matching git repository
   */
  async isMatchingRepository(directory, expectedOwner, expectedRepo) {
    try {
      // Use _createGitForDirectory for testability (can be overridden in tests)
      const git = this._createGitForDirectory(directory);

      // Check if it's a git repository
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return false;
      }

      // Get remote origin URL
      const remotes = await git.getRemotes(true);
      const origin = remotes.find(remote => remote.name === 'origin');

      if (!origin) {
        return false;
      }

      const remoteUrl = origin.refs.fetch || origin.refs.push;
      if (!remoteUrl) {
        return false;
      }

      // Parse the owner/repo from the remote URL
      const { owner, repo } = this.parseRepositoryFromURL(remoteUrl);

      // Compare case-insensitively (GitHub repos are case-insensitive)
      return owner.toLowerCase() === expectedOwner.toLowerCase() &&
             repo.toLowerCase() === expectedRepo.toLowerCase();
    } catch (error) {
      // Any error means the directory doesn't match
      return false;
    }
  }

  /**
   * Create a git instance for a given directory.
   * This method exists for testability - tests can override it.
   * @param {string} directory - Directory path
   * @returns {Object} simpleGit instance
   * @private
   */
  _createGitForDirectory(directory) {
    return simpleGit(directory);
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