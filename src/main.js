// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const { loadConfig, getConfigDir, getGitHubToken, showWelcomeMessage, resolveDbName, resolveRepoOptions, resolvePoolConfig, getRepoResetScript } = require('./config');
const { initializeDatabase, run, queryOne, query, migrateExistingWorktrees, WorktreeRepository, ReviewRepository, RepoSettingsRepository, GitHubReviewRepository, WorktreePoolRepository } = require('./database');
const { PRArgumentParser } = require('./github/parser');
const { GitHubClient } = require('./github/client');
const { GitWorktreeManager } = require('./git/worktree');
const { WorktreePoolLifecycle } = require('./git/worktree-pool-lifecycle');
const { startServer } = require('./server');
const Analyzer = require('./ai/analyzer');
const { applyConfigOverrides } = require('./ai');
const { handleLocalReview, findMainGitRoot } = require('./local-review');
const { storePRData, registerRepositoryLocation, findRepositoryPath } = require('./setup/pr-setup');
const { fireReviewStartedHook } = require('./hooks/payloads');
const { normalizeRepository, resolveRenamedFile, resolveRenamedFileOld } = require('./utils/paths');
const logger = require('./utils/logger');
const simpleGit = require('simple-git');
const { getGeneratedFilePatterns } = require('./git/gitattributes');
const { GIT_DIFF_FLAGS_ARRAY, GIT_DIFF_SUMMARY_FLAGS_ARRAY } = require('./git/diff-flags');
const { getEmoji: getCategoryEmoji } = require('./utils/category-emoji');
const open = (...args) => process.env.PAIR_REVIEW_NO_OPEN ? Promise.resolve() : import('open').then(({default: open}) => open(...args));
const { registerProtocolHandler, unregisterProtocolHandler } = require('./protocol-handler');

let db = null;

/**
 * Detect PR information from GitHub Actions environment variables.
 * Returns null if not in GitHub Actions or PR info cannot be determined.
 *
 * @returns {Object|null} { owner, repo, number } or null
 */
function detectPRFromGitHubEnvironment() {
  // Must be in GitHub Actions
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return null;
  }

  // Get owner/repo from GITHUB_REPOSITORY
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) {
    console.warn('GITHUB_REPOSITORY not set or invalid');
    return null;
  }

  const [owner, repo] = repository.split('/');

  // Try to get PR number from GITHUB_REF (format: refs/pull/123/merge)
  const ref = process.env.GITHUB_REF;
  if (ref) {
    const prMatch = ref.match(/refs\/pull\/(\d+)\//);
    if (prMatch) {
      return { owner, repo, number: parseInt(prMatch[1], 10) };
    }
  }

  // Fallback: read from event payload
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      if (event.pull_request && event.pull_request.number) {
        return { owner, repo, number: event.pull_request.number };
      }
    } catch (error) {
      console.warn(`Could not read GitHub event payload: ${error.message}`);
    }
  }

  console.warn('Could not detect PR number from GitHub Actions environment');
  return null;
}

/**
 * Get the version from package.json
 */
function getVersion() {
  const path = require('path');
  const packageJson = require(path.join(__dirname, '..', 'package.json'));
  return packageJson.version;
}

/**
 * Print help text and exit
 */
function printHelp() {
  const version = getVersion();
  console.log(`
pair-review v${version}
AI-powered GitHub pull request review assistant

USAGE:
    pair-review [OPTIONS] [<PR-number-or-URL>]

DESCRIPTION:
    Review GitHub pull requests or local changes with AI-assisted analysis.
    Opens a local web UI with a familiar review interface.

ARGUMENTS:
    <PR-number>     PR number to review (requires being in a GitHub repository)
    <PR-URL>        Full GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)

OPTIONS:
    --ai                    Automatically run AI analysis when the review loads
    --ai-draft              Run AI analysis and save suggestions as a draft
                            review on GitHub (headless mode)
    --ai-review             Run AI analysis and submit review to GitHub (CI mode)
                            Auto-detects PR in GitHub Actions environment
    --configure             Show setup instructions and configuration options
    -d, --debug             Enable verbose debug logging
    --debug-stream          Log AI provider streaming events (tool calls, text chunks)
    -h, --help              Show this help message and exit
    -l, --local [path]      Review local uncommitted changes
                            Optional path defaults to current directory
    --mcp                   Start as an MCP stdio server for AI coding agents.
                            The web UI also starts for the human reviewer.
    --model <name>          Override the AI model. Claude Code is the default provider.
                            Available models: opus, sonnet, haiku (Claude Code);
                            also: opus-4.5, opus-4.6-low, opus-4.6-medium, opus-4.6-1m
                            or use provider-specific models with Gemini/Codex
    --use-checkout          Use current directory instead of creating worktree
                            (automatic in GitHub Actions)
    --yolo                  Allow AI providers full system access (skip read-only
                            restrictions). Analogous to --dangerously-skip-permissions
    --register [--command <cmd>]  Register pair-review:// URL scheme handler (macOS)
                                Default command: npx @in-the-loop-labs/pair-review
    --unregister                Unregister pair-review:// URL scheme handler (macOS)
    -v, --version           Show version number and exit

EXAMPLES:
    pair-review 123                    # Review PR #123 in current repo
    pair-review https://github.com/owner/repo/pull/456
    pair-review --local                # Review uncommitted local changes
    pair-review 123 --ai               # Auto-run AI analysis
    pair-review --ai-review            # CI mode: auto-detect PR, submit review
    pair-review --register                     # Register URL scheme handler
    pair-review --register --command "node bin/pair-review.js"  # Custom command

ENVIRONMENT VARIABLES:
    GITHUB_TOKEN            GitHub Personal Access Token (takes precedence over config file)
    PAIR_REVIEW_CLAUDE_CMD  Custom command to invoke Claude CLI (default: claude)
    PAIR_REVIEW_GEMINI_CMD  Custom command to invoke Gemini CLI (default: gemini)
    PAIR_REVIEW_CODEX_CMD   Custom command to invoke Codex CLI (default: codex)
    PAIR_REVIEW_MODEL       Override the AI model (same as --model flag, default: opus)

CONFIGURATION:
    Config file: ~/.pair-review/config.json

    {
      "github_token": "ghp_your_token_here",
      "port": 7247,
      "theme": "light"
    }

    GitHub Personal Access Token (create at https://github.com/settings/tokens/new):
      - repo (required for private repositories)
      - public_repo (sufficient for public repositories only)

MORE INFO:
    https://github.com/in-the-loop-labs/pair-review
`);
}

/**
 * Print version and exit
 */
function printVersion() {
  console.log(`pair-review v${getVersion()}`);
}

/**
 * Asynchronously cleanup stale worktrees (runs in background, doesn't block)
 * @param {Object} config - Application configuration
 */
function cleanupStaleWorktreesAsync(config) {
  // Run cleanup asynchronously - don't await, don't block startup
  setImmediate(async () => {
    try {
      const retentionDays = config.worktree_retention_days || 7;
      const worktreeManager = new GitWorktreeManager(db);
      await worktreeManager.cleanupStaleWorktrees(retentionDays);
    } catch (error) {
      // Silently log error - cleanup failure shouldn't affect user experience
      console.error('[pair-review] Background worktree cleanup error:', error.message);
    }
  });
}

/**
 * Asynchronously cleanup stale reviews (runs in background, doesn't block)
 * @param {Object} config - Application configuration
 */
function cleanupStaleReviewsAsync(config) {
  setImmediate(async () => {
    try {
      const retentionDays = config.review_retention_days || 21;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      const cutoffISO = cutoffDate.toISOString();

      const reviewRepo = new ReviewRepository(db);
      const staleReviews = await reviewRepo.findStale(cutoffISO);

      if (staleReviews.length === 0) return;

      logger.info(`[pair-review] Cleaning up ${staleReviews.length} reviews older than ${retentionDays} days`);

      for (const review of staleReviews) {
        try {
          await reviewRepo.deleteWithRelatedData(review.id, {
            prNumber: review.pr_number,
            repository: review.repository
          });
        } catch (err) {
          logger.error(`[pair-review] Failed to cleanup review ${review.id}: ${err.message}`);
        }
      }
    } catch (error) {
      logger.error('[pair-review] Background review cleanup error:', error.message);
    }
  });
}

// Known flags that are valid (for validation)
const KNOWN_FLAGS = new Set([
  '--ai',
  '--ai-draft',
  '--ai-review',
  '--configure',
  '-d', '--debug',
  '--debug-stream',
  '-h', '--help',
  '-l', '--local',
  '--mcp',
  '--model',
  '--register',
  '--unregister',
  '--command',
  '--use-checkout',
  '--yolo',
  '-v', '--version'
]);

/**
 * Parse command line arguments to separate PR arguments from flags.
 *
 * Note: This is a simple hand-rolled parser. If the CLI grows more complex,
 * consider using a library like 'commander', 'yargs', or 'meow'.
 *
 * @param {Array<string>} args - Raw command line arguments
 * @returns {Object} { prArgs: Array<string>, flags: Object }
 */
function parseArgs(args) {
  const prArgs = [];
  const flags = {};
  const unknownFlags = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-d' || arg === '--debug') {
      flags.debug = true;
      logger.setDebugEnabled(true);
    } else if (arg === '--debug-stream') {
      flags.debugStream = true;
      logger.setStreamDebugEnabled(true);
    } else if (arg === '--ai') {
      flags.ai = true;
    } else if (arg === '--ai-draft') {
      flags.aiDraft = true;
    } else if (arg === '--ai-review') {
      flags.aiReview = true;
    } else if (arg === '--use-checkout') {
      flags.useCheckout = true;
    } else if (arg === '--yolo') {
      flags.yolo = true;
    } else if (arg === '--model') {
      // Next argument is the model name
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.model = args[i + 1];
        i++; // Skip next argument since we consumed it
      } else {
        throw new Error('--model flag requires a model name (e.g., --model sonnet)');
      }
    } else if (arg === '-l' || arg === '--local') {
      // -l/--local flag is always a boolean
      flags.local = true;
      // Next argument is optional path (if not starting with -)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.localPath = args[i + 1];
        i++; // Skip next argument since we consumed it
      }
      // localPath will be resolved to cwd if not provided
    } else if (arg === '--configure' || arg === '-h' || arg === '--help' || arg === '--mcp' || arg === '-v' || arg === '--version' || arg === '--register' || arg === '--unregister') {
      // Skip flags that are handled earlier in main()
      continue;
    } else if (arg === '--command') {
      // --command flag consumed by --register handler, skip it and its value
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        i++; // Skip the next argument (the command value)
      }
    } else if (arg.startsWith('-')) {
      // Unknown flag - collect for error reporting
      unknownFlags.push(arg);
    } else {
      // This is a PR argument (number or URL)
      prArgs.push(arg);
    }
  }

  // Error on unknown flags
  if (unknownFlags.length > 0) {
    const flagList = unknownFlags.join(', ');
    throw new Error(`Unknown flag${unknownFlags.length > 1 ? 's' : ''}: ${flagList}\nRun 'pair-review --help' for usage information.`);
  }

  return { prArgs, flags };
}

/**
 * Main application entry point
 */
async function main() {
  try {
    const args = process.argv.slice(2);

    // IMPORTANT: MCP stdio mode must be handled before ANY code that writes to stdout.
    // In MCP mode, stdout is reserved for JSON-RPC protocol messages.
    // Moving this below other handlers (help, version, config, etc.) will break MCP.
    if (args.includes('--mcp')) {
      const { startMCPStdio } = require('./mcp-stdio');
      await startMCPStdio();
      return; // process stays alive via stdin
    }

    // Handle help flag (before any other processing)
    if (args.includes('-h') || args.includes('--help')) {
      printHelp();
      process.exit(0);
    }

    // Handle version flag
    if (args.includes('-v') || args.includes('--version')) {
      printVersion();
      process.exit(0);
    }

    // Handle configuration command
    if (args.includes('--configure')) {
      console.log(`
pair-review Configuration
=========================

CONFIG FILE:
    Location: ~/.pair-review/config.json
    Created automatically on first run.

    Example config:
    {
      "github_token_command": "gh auth token",
      "port": 7247,
      "theme": "light",
      "debug_stream": false,
      "yolo": false,
      "db_name": "dev.db"
    }

GITHUB TOKEN:
    If you have the GitHub CLI (gh) installed and authenticated,
    you're all set — the default github_token_command handles it.

    Otherwise, create a Personal Access Token at:
    https://github.com/settings/tokens/new

    Required scopes:
      - repo (for private repositories)
      - public_repo (sufficient for public repositories only)

    You can provide the token via:
      1. GITHUB_TOKEN environment variable (takes precedence)
      2. github_token field in config file (**deprecated**)
      3. github_token_command in config file (**preferred** for security, default: "gh auth token")
         No secret stored in plain text. Works with gh CLI, 1Password CLI, pass, etc.

ENVIRONMENT VARIABLES:
    GITHUB_TOKEN            GitHub Personal Access Token (takes precedence over config file)
    PAIR_REVIEW_CLAUDE_CMD  Custom Claude CLI command (default: claude)
    PAIR_REVIEW_GEMINI_CMD  Custom Gemini CLI command (default: gemini)
    PAIR_REVIEW_CODEX_CMD   Custom Codex CLI command (default: codex)
    PAIR_REVIEW_MODEL       Default AI model (e.g., opus, sonnet, haiku)
    PAIR_REVIEW_DB_NAME     Custom database filename (overrides config)

LOCAL CONFIG:
    Place a .pair-review/config.json in your working directory to override
    global settings (e.g., db_name for per-worktree database isolation).

AI PROVIDERS:
    Claude (default): Requires 'claude' CLI installed
    Gemini: Requires 'gemini' CLI installed
    Codex: Requires 'codex' CLI installed

    Select provider per-repository in the web UI settings.
`);
      process.exit(0);
    }

    // Handle protocol handler registration
    if (args.includes('--register')) {
      const cmdIdx = args.indexOf('--command');
      let command;
      if (cmdIdx !== -1) {
        if (cmdIdx + 1 < args.length && !args[cmdIdx + 1].startsWith('-')) {
          command = args[cmdIdx + 1];
        } else {
          throw new Error('--command flag requires a command string');
        }
      }
      await registerProtocolHandler({ command });
      process.exit(0);
    }

    if (args.includes('--unregister')) {
      await unregisterProtocolHandler();
      process.exit(0);
    }

    // Load configuration
    const { config, isFirstRun } = await loadConfig();

    // Show welcome message on first run (after early-exit flags are handled above)
    if (isFirstRun) {
      showWelcomeMessage();
    }

    // Initialize database
    console.log('Initializing database...');
    db = await initializeDatabase(resolveDbName(config));

    // Migrate existing worktrees to database (if any)
    const path = require('path');
    const worktreeBaseDir = path.join(getConfigDir(), 'worktrees');
    const migrationResult = await migrateExistingWorktrees(db, worktreeBaseDir);
    if (migrationResult.migrated > 0) {
      console.log(`Migrated ${migrationResult.migrated} existing worktrees to database`);
    }
    if (migrationResult.errors.length > 0) {
      console.warn('Some worktrees could not be migrated:', migrationResult.errors);
    }

    // Reset stale pool entries, wire idle callbacks, and rehydrate preserved entries
    const poolLifecycle = new WorktreePoolLifecycle(db, config);
    await poolLifecycle.resetAndRehydrate();

    // Parse command line arguments including flags
    const { prArgs, flags } = parseArgs(args);

    // Apply debug_stream from config if not already enabled by CLI flag
    if (!flags.debugStream && config.debug_stream) {
      flags.debugStream = true;
      logger.setStreamDebugEnabled(true);
    }

    // Apply yolo mode from CLI flag or config
    if (flags.yolo || config.yolo) {
      // config.yolo: used by applyConfigOverrides() for this process
      config.yolo = true;
      // Env var: bridges to server.js which reloads config from disk independently
      process.env.PAIR_REVIEW_YOLO = 'true';
    }

    // Apply provider config overrides (including yolo) for all code paths
    // (interactive, headless, local). server.js calls this independently on
    // startup, but headless paths (--ai-draft, --ai-review) never start the
    // server, so we must also apply here.
    applyConfigOverrides(config);

    // Check for local mode (review uncommitted local changes)
    if (flags.local) {
      // Resolve localPath, defaulting to cwd if not provided
      const targetPath = flags.localPath || process.cwd();
      await handleLocalReview(targetPath, flags);

      // Async cleanup of stale worktrees and reviews (don't block startup)
      cleanupStaleWorktreesAsync(config);
      cleanupStaleReviewsAsync(config);
      startPoolBackgroundFetches(db, config);

      return;
    }

    // Auto-detect GitHub Actions environment
    const isGitHubAction = process.env.GITHUB_ACTIONS === 'true';
    let effectivePrArgs = prArgs;

    // In GitHub Actions, auto-detect PR if no args provided and using --ai-review
    if (isGitHubAction && prArgs.length === 0 && flags.aiReview) {
      const prInfo = detectPRFromGitHubEnvironment();
      if (prInfo) {
        effectivePrArgs = [`https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`];
        console.log(`Detected PR #${prInfo.number} from GitHub Actions environment`);
        // Auto-enable use-checkout in GitHub Actions
        flags.useCheckout = true;
      }
    }

    // Check if PR arguments were provided
    if (effectivePrArgs.length > 0) {
      // Warn if multiple AI flags are provided
      const aiFlags = [flags.ai, flags.aiDraft, flags.aiReview].filter(Boolean).length;
      if (aiFlags > 1) {
        console.log('⚠️  Warning: Multiple AI flags provided. Using highest precedence: --ai-review > --ai-draft > --ai');
      }

      if (flags.useCheckout && !flags.aiDraft && !flags.aiReview) {
        console.log('⚠️  Warning: --use-checkout has no effect in interactive mode (requires --ai-draft or --ai-review)');
      }

      // Check for --ai-review mode (takes precedence over --ai-draft and --ai)
      if (flags.aiReview) {
        await handleActionReview(effectivePrArgs, config, db, flags, poolLifecycle);
      } else if (flags.aiDraft) {
        await handleDraftModeReview(effectivePrArgs, config, db, flags, poolLifecycle);
      } else {
        await handlePullRequest(effectivePrArgs, config, db, flags, poolLifecycle);
      }
    } else {
      // Check if --ai or --ai-draft flags were used without PR identifier
      if (flags.ai) {
        throw new Error('--ai flag requires a pull request number or URL to be specified');
      }
      if (flags.aiDraft) {
        throw new Error('--ai-draft flag requires a pull request number or URL to be specified');
      }
      if (flags.aiReview) {
        throw new Error('--ai-review flag requires a pull request number or URL (or run in GitHub Actions environment)');
      }

      // No PR arguments - just start the server
      console.log('No pull request specified. Starting server...');
      await startServerOnly(config, poolLifecycle);
    }
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Handle pull request processing
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed command line flags
 * @param {import('./git/worktree-pool-lifecycle').WorktreePoolLifecycle} [poolLifecycle] - Pool lifecycle instance
 */
async function handlePullRequest(args, config, db, flags = {}, poolLifecycle = null) {
  try {
    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      throw new Error('GitHub token not found. Set GITHUB_TOKEN env var, add github_token to config, or set github_token_command (e.g., "gh auth token"). Run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    const prInfo = await parser.parsePRArguments(args);

    // Register cwd as known repo path if it matches the target repo
    const currentDir = parser.getCurrentDirectory();
    const isMatchingRepo = await parser.isMatchingRepository(currentDir, prInfo.owner, prInfo.repo);
    if (isMatchingRepo) {
      await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);
    }

    // Set model override if provided via CLI flag
    if (flags.model) {
      process.env.PAIR_REVIEW_MODEL = flags.model;
    }

    // Start server and open browser to setup page
    const port = await startServer(db, poolLifecycle);

    // Async cleanup of stale worktrees and reviews (don't block startup)
    cleanupStaleWorktreesAsync(config);
    cleanupStaleReviewsAsync(config);
    startPoolBackgroundFetches(db, config);

    let url = `http://localhost:${port}/pr/${prInfo.owner}/${prInfo.repo}/${prInfo.number}`;
    if (flags.ai) {
      url += '?analyze=true';
    }

    console.log(`Opening browser to: ${url}`);
    await open(url);

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
  }
}

/**
 * Start server without PR context
 * @param {Object} config - Application configuration
 * @param {import('./git/worktree-pool-lifecycle').WorktreePoolLifecycle} [poolLifecycle] - Pool lifecycle instance
 */
async function startServerOnly(config, poolLifecycle = null) {
  const port = await startServer(db, poolLifecycle);

  // Async cleanup of stale worktrees and reviews (don't block startup)
  cleanupStaleWorktreesAsync(config);
  cleanupStaleReviewsAsync(config);
  startPoolBackgroundFetches(db, config);

  // Open browser to landing page
  const url = `http://localhost:${port}/`;
  console.log(`Opening browser to: ${url}`);
  await open(url);
}


/**
 * Format AI suggestion with emoji and category prefix
 * @param {string} text - The suggestion text
 * @param {string} category - The suggestion category
 * @returns {string} Formatted comment text
 */
function formatAISuggestion(text, category) {
  if (!category) {
    return text;
  }
  const emoji = getCategoryEmoji(category);
  // Properly capitalize hyphenated categories (e.g., "code-style" -> "Code Style")
  const capitalizedCategory = category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return `${emoji} **${capitalizedCategory}**: ${text}`;
}

/**
 * Shared implementation for headless (non-interactive) review modes.
 * Used by both --ai-draft and --ai-review.
 *
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed CLI flags
 * @param {Object} options - Mode-specific options
 * @param {string} options.mode - 'draft' or 'review'
 * @param {string} options.reviewEvent - 'DRAFT' or 'COMMENT'
 * @param {string} options.commentStatus - 'draft' or 'submitted'
 * @param {string} options.modeLabel - Display label for log messages (e.g., 'draft mode', 'action review mode')
 * @param {import('../git/worktree-pool-lifecycle').WorktreePoolLifecycle} [externalPoolLifecycle] - Shared pool lifecycle instance (avoids creating a fresh singleton)
 */
async function performHeadlessReview(args, config, db, flags, options, externalPoolLifecycle = null) {
  let prInfo = null;
  let poolWorktreeId = null;
  let poolLifecycle = null;

  try {
    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      throw new Error('GitHub token not found. Set GITHUB_TOKEN env var, add github_token to config, or set github_token_command (e.g., "gh auth token"). Run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    prInfo = await parser.parsePRArguments(args);

    console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo} in ${options.modeLabel}`);

    // Create GitHub client and verify repository access
    const githubClient = new GitHubClient(githubToken);
    const repoExists = await githubClient.repositoryExists(prInfo.owner, prInfo.repo);
    if (!repoExists) {
      throw new Error(`Repository ${prInfo.owner}/${prInfo.repo} not found or not accessible`);
    }

    // Fetch PR data from GitHub
    console.log('Fetching pull request data from GitHub...');
    const prData = await githubClient.fetchPullRequest(prInfo.owner, prInfo.repo, prInfo.number);

    let worktreePath;
    let diff;
    let changedFiles;
    const repository = normalizeRepository(prInfo.owner, prInfo.repo);

    // Determine working directory: --use-checkout uses current directory
    if (flags.useCheckout) {
      worktreePath = process.cwd();

      // Verify cwd matches the target repository when using --use-checkout
      const isMatchingRepo = await parser.isMatchingRepository(worktreePath, prInfo.owner, prInfo.repo);
      if (!isMatchingRepo) {
        throw new Error(
          `--use-checkout requires running from a checkout of ${prInfo.owner}/${prInfo.repo}, ` +
          `but current directory does not match. Either cd to the correct repository or remove --use-checkout.`
        );
      }

      await registerRepositoryLocation(db, worktreePath, prInfo.owner, prInfo.repo);
      console.log(`Using current checkout at ${worktreePath}`);

      // Generate diff directly from current checkout
      console.log('Generating unified diff from checkout...');
      const git = simpleGit(worktreePath);

      // Ensure we have the base SHA available (fetch if needed)
      try {
        await git.fetch(['origin', prData.base_sha]);
      } catch (fetchError) {
        // Fetch by SHA may fail (not all servers support it); verify SHA is available locally
        try {
          await git.raw(['cat-file', '-t', prData.base_sha]);
        } catch {
          throw new Error(`Base SHA ${prData.base_sha} is not available locally and fetch failed: ${fetchError.message}`);
        }
      }

      diff = await git.diff([
        `${prData.base_sha}...${prData.head_sha}`,
        '--unified=3',
        ...GIT_DIFF_FLAGS_ARRAY
      ]);

      // Get changed files
      const diffSummary = await git.diffSummary([
        `${prData.base_sha}...${prData.head_sha}`,
        ...GIT_DIFF_SUMMARY_FLAGS_ARRAY
      ]);
      const gitattributes = await getGeneratedFilePatterns(worktreePath);

      changedFiles = diffSummary.files.map(file => {
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
    } else {
      // Use worktree approach - only use cwd if it matches the target repo
      const currentDir = parser.getCurrentDirectory();
      const isMatchingRepo = await parser.isMatchingRepository(currentDir, prInfo.owner, prInfo.repo);

      let repositoryPath;
      let worktreeSourcePath;
      let checkoutScript;
      let checkoutTimeout;
      let worktreeConfig = null;
      let poolSize = 0;
      let resetScript = null;
      if (isMatchingRepo) {
        // Current directory is a checkout of the target repository
        repositoryPath = currentDir;
        await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);

        // Resolve monorepo config options (checkout_script, worktree_directory, worktree_name_template)
        // even when running from inside the target repo, so they are not silently ignored.
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
        const resolved = resolveRepoOptions(config, repository, repoSettings);
        checkoutScript = resolved.checkoutScript;
        checkoutTimeout = resolved.checkoutTimeout;
        worktreeConfig = resolved.worktreeConfig;
        poolSize = resolved.poolSize || 0;
        resetScript = resolved.resetScript || null;
      } else {
        // Current directory is not the target repository - find or clone it
        console.log(`Current directory is not a checkout of ${prInfo.owner}/${prInfo.repo}, locating repository...`);
        const result = await findRepositoryPath({
          db,
          owner: prInfo.owner,
          repo: prInfo.repo,
          repository,
          prNumber: prInfo.number,
          config,
          onProgress: (progress) => {
            if (progress.message) {
              console.log(progress.message);
            }
          }
        });
        repositoryPath = result.repositoryPath;
        worktreeSourcePath = result.worktreeSourcePath;
        checkoutScript = result.checkoutScript;
        checkoutTimeout = result.checkoutTimeout;
        worktreeConfig = result.worktreeConfig;
        // findRepositoryPath doesn't return pool config; resolve from DB + file config
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
        const { poolSize: resolvedPoolSize, poolFetchIntervalMinutes: _resolvedFetchInterval } = resolvePoolConfig(config, repository, repoSettings);
        poolSize = resolvedPoolSize || 0;
        resetScript = config ? getRepoResetScript(config, repository) : null;
      }

      const worktreeManager = new GitWorktreeManager(db, worktreeConfig || {});
      if (poolSize > 0) {
        // Pool mode: use WorktreePoolLifecycle
        console.log('Acquiring pool worktree...');
        poolLifecycle = externalPoolLifecycle || new WorktreePoolLifecycle(db, config);
        const result = await poolLifecycle.acquireForPR(
          { owner: prInfo.owner, repo: prInfo.repo, prNumber: prInfo.number, repository },
          prData,
          repositoryPath,
          { worktreeSourcePath, checkoutScript, checkoutTimeout, resetScript, worktreeConfig, poolSize }
        );
        worktreePath = result.worktreePath;
        poolWorktreeId = result.worktreeId;
        console.log('Pool worktree acquired');
      } else {
        // Non-pool mode: existing behavior
        console.log('Setting up git worktree...');
        ({ path: worktreePath } = await worktreeManager.createWorktreeForPR(prInfo, prData, repositoryPath, {
          worktreeSourcePath,
          checkoutScript,
          checkoutTimeout
        }));
      }

      console.log('Generating unified diff...');
      diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
      changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);
    }

    // Store PR data in database
    console.log('Storing pull request data...');
    const { isNewReview, reviewId: storedReviewId } = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
      skipWorktreeRecord: !!flags.useCheckout
    });

    // Persist review→worktree mapping in DB for pool usage tracking
    if (poolWorktreeId && poolLifecycle) {
      await poolLifecycle.setReviewOwner(poolWorktreeId, storedReviewId);
    }

    // Fire review.started hook for new reviews (non-blocking)
    if (isNewReview) {
      fireReviewStartedHook({
        reviewId: storedReviewId, prNumber: prInfo.number,
        owner: prInfo.owner, repo: prInfo.repo, prData, config,
      }).catch(err => { logger.warn(`Review hook failed: ${err.message}`); });
    }

    // Get PR metadata ID for AI analysis
    const prMetadata = await queryOne(db, `
      SELECT id, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    if (!prMetadata) {
      throw new Error('Failed to retrieve stored PR metadata');
    }

    const storedPRData = JSON.parse(prMetadata.pr_data);

    // Get or create a review record for this PR
    // The review.id is passed to the analyzer so comments use review.id, not prMetadata.id
    // This avoids ID collision with local mode where comments also use reviews.id
    const reviewRepo = new ReviewRepository(db);
    const { review } = await reviewRepo.getOrCreate({ prNumber: prInfo.number, repository });

    // Fetch repo settings to get default instructions
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
    const repoInstructions = repoSettings?.default_instructions || null;
    const globalInstructions = config.globalInstructions || null;

    // Run AI analysis
    console.log('Running AI analysis (all 3 levels)...');
    const model = flags.model || process.env.PAIR_REVIEW_MODEL || 'opus';
    const analyzer = new Analyzer(db, model);

    let analysisSummary = null;
    try {
      // Pass all instruction levels to ensure they're captured in the analysis run
      const analysisResult = await analyzer.analyzeAllLevels(review.id, worktreePath, storedPRData, null, { globalInstructions, repoInstructions });
      analysisSummary = analysisResult.summary;
      console.log('AI analysis completed successfully');
    } catch (analysisError) {
      console.error(`AI analysis failed: ${analysisError.message}`);
      console.error('Suggestions (if any) have been saved to the database.');
      console.error(`You can run pair-review without --ai-${options.mode} to view them in the UI.`);
      throw new Error(`AI analysis failed: ${analysisError.message}`);
    }

    // Query for final AI suggestions (orchestrated, not per-level)
    // Use review.id (not prMetadata.id) to match how comments are stored
    const aiSuggestions = await query(db, `
      SELECT
        id,
        file,
        line_start,
        body,
        diff_position,
        title,
        type
      FROM comments
      WHERE review_id = ? AND source = 'ai' AND ai_level IS NULL AND (is_raw = 0 OR is_raw IS NULL) AND status = 'active'
      ORDER BY file, line_start
    `, [review.id]);

    console.log(`Found ${aiSuggestions.length} AI suggestions to submit`);

    if (aiSuggestions.length === 0) {
      console.log('No AI suggestions to submit. Exiting without creating review.');
      return; // Exit gracefully without creating a review
    }

    // Filter out suggestions without valid line information
    // Note: diff positions will be recalculated fresh by GitHub client
    const validSuggestions = aiSuggestions.filter(suggestion => {
      const hasValidLine = suggestion.line_start && suggestion.line_start > 0;
      const hasValidPath = suggestion.file && suggestion.file.trim() !== '';

      if (!hasValidLine || !hasValidPath) {
        console.warn(`Skipping suggestion for ${suggestion.file || 'unknown file'}:${suggestion.line_start || 'unknown line'} - missing valid line or path information`);
        return false;
      }

      return true;
    });

    console.log(`Filtered to ${validSuggestions.length} suggestions with valid line information`);

    if (validSuggestions.length === 0) {
      console.log('No suggestions with valid line information. Exiting without creating review.');
      return; // Exit gracefully without creating a review
    }

    // Format AI suggestions for GitHub
    const githubComments = validSuggestions.map(suggestion => {
      // Format with emoji and category prefix, same as adopted suggestions
      const formattedBody = formatAISuggestion(suggestion.body, suggestion.type);

      return {
        path: suggestion.file,
        line: suggestion.line_start,
        body: formattedBody,
        side: 'RIGHT',    // AI suggestions always target added/modified code
        isFileLevel: false // AI suggestions always target specific lines
      };
    });

    // Build review body with AI-generated summary
    const footerFlag = options.mode === 'draft' ? '--ai-draft' : '--ai-review';
    const reviewBody = analysisSummary
      ? `## AI Analysis Summary

${analysisSummary}

> Generated by [pair-review](https://github.com/in-the-loop-labs/pair-review) with \`${footerFlag}\` mode`
      : `## AI Analysis Summary

Found ${validSuggestions.length} suggestion${validSuggestions.length === 1 ? '' : 's'} from automated analysis.

> Generated by [pair-review](https://github.com/in-the-loop-labs/pair-review) with \`${footerFlag}\` mode`;

    // Submit review to GitHub via GraphQL (same path as web UI)
    console.log(`Submitting review with ${githubComments.length} comments...`);

    const prNodeId = storedPRData.node_id;
    if (!prNodeId) {
      throw new Error(`PR node_id not available for ${prInfo.owner}/${prInfo.repo}#${prInfo.number}. Cannot submit review without GraphQL node ID.`);
    }

    // Check for existing pending draft (GitHub only allows one per user per PR)
    const existingDraft = await githubClient.getPendingReviewForUser(
      prInfo.owner, prInfo.repo, prInfo.number
    );

    let githubReview;
    if (options.reviewEvent === 'DRAFT') {
      githubReview = await githubClient.createDraftReviewGraphQL(
        prNodeId, reviewBody, githubComments, existingDraft?.id
      );
    } else {
      githubReview = await githubClient.createReviewGraphQL(
        prNodeId, options.reviewEvent, reviewBody, githubComments, existingDraft?.id
      );
    }

    // When adding to an existing draft, use the existing URL and include prior comments in total count
    if (existingDraft) {
      githubReview.html_url = githubReview.html_url || existingDraft.url;
      githubReview.comments_count = existingDraft.comments.totalCount + githubReview.comments_count;
    }

    // ID storage strategy (matches pr.js convention):
    // - github_reviews.github_review_id -> numeric database ID
    // - github_reviews.github_node_id -> GraphQL node ID (e.g., "PRR_kwDOM...")
    // - reviewData JSON -> uses 'github_node_id' key for the GraphQL node ID
    const githubNodeId = String(githubReview.id); // GraphQL methods return node IDs
    const githubDatabaseId = githubReview.databaseId
      ? String(githubReview.databaseId)
      : existingDraft ? String(existingDraft.databaseId) : null;

    const githubReviewState = options.reviewEvent === 'DRAFT' ? 'pending' : 'submitted';

    // Update database to track the review
    await run(db, 'BEGIN TRANSACTION');

    try {
      const now = new Date().toISOString();
      const reviewData = {
        github_node_id: githubNodeId,
        github_url: githubReview.html_url,
        event: options.reviewEvent,
        body: reviewBody || '',
        comments_count: githubReview.comments_count,
        created_at: now
      };

      // Update review record via repository method
      // Uses UPDATE (not INSERT OR REPLACE) to avoid cascade deletion of comments/analysis_runs
      await reviewRepo.updateAfterSubmission(review.id, {
        event: options.reviewEvent,
        reviewData: reviewData
      });

      // Create a github_reviews record to track this submission (matches pr.js)
      const githubReviewRepo = new GitHubReviewRepository(db);
      await githubReviewRepo.create(review.id, {
        github_review_id: githubDatabaseId,
        github_node_id: githubNodeId,
        state: githubReviewState,
        body: reviewBody || '',
        github_url: githubReview.html_url
      });

      // Update AI suggestions to appropriate status (batch update for performance)
      // Use validSuggestions (not aiSuggestions) to only update those that were actually submitted
      if (validSuggestions.length > 0) {
        const suggestionIds = validSuggestions.map(s => s.id);
        const placeholders = suggestionIds.map(() => '?').join(',');
        await run(db, `
          UPDATE comments
          SET status = ?, updated_at = ?
          WHERE id IN (${placeholders})
        `, [options.commentStatus, now, ...suggestionIds]);
      }

      await run(db, 'COMMIT');

      const successLabel = options.reviewEvent === 'DRAFT' ? 'Draft review created' : 'Review submitted';
      console.log(`\n✅ ${successLabel} successfully!`);
      console.log(`   Review URL: ${githubReview.html_url}`);
      console.log(`   Comments submitted: ${githubReview.comments_count}\n`);

    } catch (dbError) {
      await run(db, 'ROLLBACK');
      throw dbError;
    }

  } catch (error) {
    // Provide cleaner error messages for common issues
    if (error.message && error.message.includes('not found in repository')) {
      if (prInfo) {
        console.error(`\n❌ Pull request #${prInfo.number} does not exist in ${prInfo.owner}/${prInfo.repo}`);
      } else {
        console.error(`\n❌ ${error.message}`);
      }
      console.error('Please check the PR number and try again.\n');
    } else if (error.message && error.message.includes('authentication failed')) {
      console.error('\n❌ GitHub authentication failed');
      console.error('Please check your token in ~/.pair-review/config.json\n');
    } else if (error.message && error.message.includes('Repository') && error.message.includes('not found')) {
      console.error(`\n❌ ${error.message}`);
      console.error('Please check the repository name and your access permissions.\n');
    } else if (error.message && error.message.includes('Network error')) {
      console.error('\n❌ Network connection error');
      console.error('Please check your internet connection and try again.\n');
    } else {
      // For other errors, show a clean message without stack trace
      console.error(`\n❌ Error: ${error.message}\n`);
    }
    process.exitCode = 1;
  } finally {
    // Release pool worktree after headless review completes (success or failure).
    // Headless reviews are fire-and-forget with no persistent browser session,
    // so the pool slot must be freed immediately.
    if (poolWorktreeId && poolLifecycle) {
      try {
        await poolLifecycle.releaseAfterHeadless(poolWorktreeId);
        logger.info(`Released pool worktree ${poolWorktreeId} after headless review`);
      } catch (releaseErr) {
        logger.error(`Failed to release pool worktree ${poolWorktreeId}: ${releaseErr.message}`);
      }
    }
  }
}

/**
 * Handle draft mode review workflow
 * Runs AI analysis and submits draft review to GitHub without opening browser
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed command line flags
 * @param {import('../git/worktree-pool-lifecycle').WorktreePoolLifecycle} [poolLifecycle] - Shared pool lifecycle instance
 */
async function handleDraftModeReview(args, config, db, flags = {}, poolLifecycle = null) {
  await performHeadlessReview(args, config, db, flags, {
    mode: 'draft',
    reviewEvent: 'DRAFT',
    commentStatus: 'draft',
    modeLabel: 'draft mode'
  }, poolLifecycle);
}

/**
 * Handle GitHub Action review mode.
 * Submits as COMMENT (not DRAFT), supports --use-checkout.
 *
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed command line flags
 * @param {import('../git/worktree-pool-lifecycle').WorktreePoolLifecycle} [poolLifecycle] - Shared pool lifecycle instance
 */
async function handleActionReview(args, config, db, flags = {}, poolLifecycle = null) {
  await performHeadlessReview(args, config, db, flags, {
    mode: 'review',
    reviewEvent: 'COMMENT',
    commentStatus: 'submitted',
    modeLabel: 'action review mode'
  }, poolLifecycle);
}

/**
 * Start periodic background fetches for pool worktrees.
 * For each repo with pool_fetch_interval_minutes configured, run git fetch
 * on all pool worktrees serially, coldest first.
 * @param {Object} db - Database instance
 * @param {Object} config - Configuration object
 */
const POOL_FETCH_TICK_MS = 60 * 1000; // Check every minute

function startPoolBackgroundFetches(db, config) {
  let fetchInProgress = false;

  const timer = setInterval(async () => {
    if (fetchInProgress) return;
    fetchInProgress = true;
    try {
      const poolRepo = new WorktreePoolRepository(db);
      const repoSettingsRepo = new RepoSettingsRepository(db);

      // Collect repos that might have pool config from either source
      const repoNames = new Set(Object.keys(config.repos || {}));
      const allRepoSettings = await query(db, 'SELECT repository, pool_size, pool_fetch_interval_minutes FROM repo_settings WHERE pool_size IS NOT NULL OR pool_fetch_interval_minutes IS NOT NULL');
      for (const row of allRepoSettings) {
        repoNames.add(row.repository);
      }

      if (repoNames.size === 0) return;

      for (const repoName of repoNames) {
        const repoSettings = allRepoSettings.find(r => r.repository.toLowerCase() === repoName.toLowerCase()) || null;
        const { poolSize, poolFetchIntervalMinutes } = resolvePoolConfig(config, repoName, repoSettings);
        if (!poolSize || !poolFetchIntervalMinutes) continue;

        // Skip if another server instance is already fetching this repo.
        // Pool worktrees share a git object store so concurrent fetches conflict.
        if (await repoSettingsRepo.isFetchInProgress(repoName)) {
          logger.info(`Background fetch skipped for ${repoName}: another instance is fetching`);
          continue;
        }

        const intervalMs = poolFetchIntervalMinutes * 60 * 1000;
        const worktrees = await poolRepo.findAllForFetch(repoName);

        // Check if any worktree actually needs fetching before claiming the lock
        const needsFetch = worktrees.some(entry => {
          if (!entry.last_fetched_at) return true;
          const elapsed = Date.now() - new Date(entry.last_fetched_at).getTime();
          return elapsed >= intervalMs;
        });
        if (!needsFetch) continue;

        await repoSettingsRepo.markFetchStarted(repoName);
        try {
          for (const entry of worktrees) {
            // Skip if fetched recently (within the configured interval)
            if (entry.last_fetched_at) {
              const elapsed = Date.now() - new Date(entry.last_fetched_at).getTime();
              if (elapsed < intervalMs) continue;
            }

            logger.info(`Background fetch starting for ${repoName} pool worktree ${entry.id}`);
            try {
              const git = simpleGit(entry.path, { timeout: { block: 300000 } });
              const remotes = await git.getRemotes();
              const remote = remotes.find(r => r.name === 'origin') || remotes[0];
              if (remote) await git.fetch([remote.name, '--prune']);
              await poolRepo.updateLastFetched(entry.id);
              logger.info(`Background fetch complete for ${repoName} pool worktree ${entry.id}`);
            } catch (fetchErr) {
              logger.warn(`Background fetch failed for ${entry.id}: ${fetchErr.message}`);
            }
          }
        } finally {
          await repoSettingsRepo.markFetchFinished(repoName);
        }
      }
    } catch (err) {
      logger.error(`Background pool fetch error: ${err.message}`, err);
    } finally {
      fetchInProgress = false;
    }
  }, POOL_FETCH_TICK_MS);

  // Don't keep the process alive just for background fetches
  if (timer.unref) timer.unref();

  logger.info(`Background pool fetch ticker started (checking every ${POOL_FETCH_TICK_MS / 1000}s)`);
}

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  
  if (db) {
    db.close((error) => {
      if (error) {
        console.error('Error closing database:', error.message);
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the application if this file is run directly
if (require.main === module) {
  main();
}

module.exports = { main, parseArgs, detectPRFromGitHubEnvironment };