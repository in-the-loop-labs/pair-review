// SPDX-License-Identifier: GPL-3.0-or-later
const { loadConfig, getConfigDir, getGitHubToken, showWelcomeMessage } = require('./config');
const { initializeDatabase, run, queryOne, query, migrateExistingWorktrees, WorktreeRepository, ReviewRepository, RepoSettingsRepository, GitHubReviewRepository } = require('./database');
const { PRArgumentParser } = require('./github/parser');
const { GitHubClient } = require('./github/client');
const { GitWorktreeManager } = require('./git/worktree');
const { startServer } = require('./server');
const Analyzer = require('./ai/analyzer');
const { handleLocalReview, findMainGitRoot } = require('./local-review');
const { normalizeRepository } = require('./utils/paths');
const logger = require('./utils/logger');
const open = (...args) => import('open').then(({default: open}) => open(...args));

let db = null;

/**
 * Register the known location of a GitHub repository in the database.
 * This allows the web UI to find the repo without cloning when reviewing PRs.
 *
 * @param {Object} db - Database instance
 * @param {string} currentDir - Current working directory (or any directory in the repo)
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<void>}
 */
async function registerRepositoryLocation(db, currentDir, owner, repo) {
  const repository = normalizeRepository(owner, repo);
  try {
    // Use findMainGitRoot to resolve worktrees to their parent repo
    // This ensures we always store the actual git root, not a worktree path
    const gitRoot = await findMainGitRoot(currentDir);
    const repoSettingsRepo = new RepoSettingsRepository(db);
    await repoSettingsRepo.setLocalPath(repository, gitRoot);
    console.log(`Registered repository location: ${gitRoot}`);
  } catch (error) {
    // Non-fatal: registration failure shouldn't block the review
    console.warn(`Could not register repository location: ${error.message}`);
  }
}

/**
 * Detect PR information from GitHub Actions environment variables.
 * Returns null if not in GitHub Actions or PR info cannot be determined.
 *
 * @returns {Object|null} { owner, repo, number } or null
 */
function detectPRFromGitHubEnvironment() {
  const fs = require('fs');

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
    --fail-on-issues        Exit with code 2 if AI finds issues (for CI)
    -h, --help              Show this help message and exit
    -l, --local [path]      Review local uncommitted changes
                            Optional path defaults to current directory
    --model <name>          Override the AI model. Claude Code is the default provider.
                            Available models: opus, sonnet, haiku (Claude Code);
                            or use provider-specific models with Gemini/Codex
    --use-checkout          Use current directory instead of creating worktree
                            (automatic in GitHub Actions)
    -v, --version           Show version number and exit

EXAMPLES:
    pair-review 123                    # Review PR #123 in current repo
    pair-review https://github.com/owner/repo/pull/456
    pair-review --local                # Review uncommitted local changes
    pair-review 123 --ai               # Auto-run AI analysis
    pair-review --ai-review            # CI mode: auto-detect PR, submit review

ENVIRONMENT VARIABLES:
    GITHUB_TOKEN            GitHub Personal Access Token (takes precedence over config file)
    PAIR_REVIEW_CLAUDE_CMD  Custom command to invoke Claude CLI (default: claude)
    PAIR_REVIEW_GEMINI_CMD  Custom command to invoke Gemini CLI (default: gemini)
    PAIR_REVIEW_CODEX_CMD   Custom command to invoke Codex CLI (default: codex)
    PAIR_REVIEW_MODEL       Override the AI model (same as --model flag)

CONFIGURATION:
    Config file: ~/.pair-review/config.json

    {
      "github_token": "ghp_your_token_here",
      "port": 3000,
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

// Known flags that are valid (for validation)
const KNOWN_FLAGS = new Set([
  '--ai',
  '--ai-draft',
  '--ai-review',
  '--configure',
  '-d', '--debug',
  '--debug-stream',
  '--fail-on-issues',
  '-h', '--help',
  '-l', '--local',
  '--model',
  '--use-checkout',
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
    } else if (arg === '--fail-on-issues') {
      flags.failOnIssues = true;
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
    } else if (arg === '--configure' || arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version') {
      // Skip flags that are handled earlier in main()
      continue;
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
      "github_token": "ghp_your_token_here",
      "port": 3000,
      "theme": "light",
      "debug_stream": true
    }

GITHUB TOKEN:
    Create a Personal Access Token at:
    https://github.com/settings/tokens/new

    Required scopes:
      - repo (for private repositories)
      - public_repo (sufficient for public repositories only)

    You can provide the token via:
      1. GITHUB_TOKEN environment variable (takes precedence)
      2. github_token field in config file

ENVIRONMENT VARIABLES:
    GITHUB_TOKEN            GitHub Personal Access Token (takes precedence over config file)
    PAIR_REVIEW_CLAUDE_CMD  Custom Claude CLI command (default: claude)
    PAIR_REVIEW_GEMINI_CMD  Custom Gemini CLI command (default: gemini)
    PAIR_REVIEW_CODEX_CMD   Custom Codex CLI command (default: codex)
    PAIR_REVIEW_MODEL       Default AI model (e.g., opus, sonnet, haiku)

AI PROVIDERS:
    Claude (default): Requires 'claude' CLI installed
    Gemini: Requires 'gemini' CLI installed
    Codex: Requires 'codex' CLI installed

    Select provider per-repository in the web UI settings.
`);
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
    db = await initializeDatabase();

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

    // Parse command line arguments including flags
    const { prArgs, flags } = parseArgs(args);

    // Apply debug_stream from config if not already enabled by CLI flag
    if (!flags.debugStream && config.debug_stream) {
      flags.debugStream = true;
      logger.setStreamDebugEnabled(true);
    }

    // Check for local mode (review uncommitted local changes)
    if (flags.local) {
      // Resolve localPath, defaulting to cwd if not provided
      const targetPath = flags.localPath || process.cwd();
      await handleLocalReview(targetPath, flags);
      return; // Exit after local review
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

      // Check for --ai-review mode (takes precedence over --ai-draft and --ai)
      if (flags.aiReview) {
        await handleActionReview(effectivePrArgs, config, db, flags);
      } else if (flags.aiDraft) {
        await handleDraftModeReview(effectivePrArgs, config, db, flags);
      } else {
        await handlePullRequest(effectivePrArgs, config, db, flags);
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
      await startServerOnly(config);
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
 */
async function handlePullRequest(args, config, db, flags = {}) {
  let prInfo = null; // Declare prInfo outside try block for error handling
  
  try {
    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      throw new Error('GitHub token not found. Set GITHUB_TOKEN environment variable or run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    prInfo = await parser.parsePRArguments(args);

    console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo}`);

    // Create GitHub client and validate token
    const githubClient = new GitHubClient(githubToken);
    const tokenValid = await githubClient.validateToken();
    if (!tokenValid) {
      throw new Error('GitHub authentication failed. Check your token in ~/.pair-review/config.json');
    }

    // Check if repository is accessible
    const repoExists = await githubClient.repositoryExists(prInfo.owner, prInfo.repo);
    if (!repoExists) {
      throw new Error(`Repository ${prInfo.owner}/${prInfo.repo} not found or not accessible`);
    }

    // Fetch PR data from GitHub
    console.log('Fetching pull request data from GitHub...');
    const prData = await githubClient.fetchPullRequest(prInfo.owner, prInfo.repo, prInfo.number);

    // Get current repository path
    const currentDir = parser.getCurrentDirectory();

    // Register the known repository location for future web UI usage
    await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);

    // Setup git worktree
    console.log('Setting up git worktree...');
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, currentDir);

    // Generate unified diff
    console.log('Generating unified diff...');
    const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

    // Store PR data in database
    console.log('Storing pull request data...');
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath);

    // Start server with PR context
    console.log('Starting server...');
    const port = await startServerWithPRContext(config, prInfo, flags);

    // Trigger AI analysis server-side if --ai flag is present
    if (flags.ai) {
      console.log('Starting AI analysis...');

      // Wait for server to be ready with retry logic
      const maxRetries = 5;
      const retryDelay = 200; // ms
      let lastError;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Add small delay to ensure server is fully initialized
          if (attempt > 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          }

          const response = await fetch(`http://localhost:${port}/api/analyze/${prInfo.owner}/${prInfo.repo}/${prInfo.number}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });

          if (response.ok) {
            const result = await response.json();
            console.log(`AI analysis started (ID: ${result.analysisId})`);
            break; // Success, exit retry loop
          } else {
            lastError = `Server responded with ${response.status}: ${await response.text()}`;
            if (attempt === maxRetries) {
              console.warn('Failed to start AI analysis:', lastError);
            }
          }
        } catch (error) {
          lastError = error.message;
          if (attempt === maxRetries) {
            console.warn('Could not start AI analysis after', maxRetries, 'attempts:', lastError);
          }
        }
      }
    }

    // Open browser to PR view
    const url = `http://localhost:${port}/pr/${prInfo.owner}/${prInfo.repo}/${prInfo.number}`;

    console.log(`Opening browser to: ${url}`);
    await open(url);

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
    process.exit(1);
  }
}

/**
 * Start server without PR context
 * @param {Object} config - Application configuration
 */
async function startServerOnly(config) {
  const port = await startServer(db);

  // Async cleanup of stale worktrees (don't block startup)
  cleanupStaleWorktreesAsync(config);

  // Open browser to landing page
  const url = `http://localhost:${port}/`;
  console.log(`Opening browser to: ${url}`);
  await open(url);
}

/**
 * Start server with PR context
 * @param {Object} config - Application configuration
 * @param {Object} prInfo - PR information
 * @param {Object} flags - Command line flags
 * @returns {Promise<number>} Server port
 */
async function startServerWithPRContext(config, prInfo, flags = {}) {
  // Set environment variable for PR context
  process.env.PAIR_REVIEW_PR = JSON.stringify(prInfo);

  // Set environment variable for auto-AI flag
  if (flags.ai) {
    process.env.PAIR_REVIEW_AUTO_AI = 'true';
  }

  // Set environment variable for model override (CLI takes priority)
  if (flags.model) {
    process.env.PAIR_REVIEW_MODEL = flags.model;
  }

  const { startServer } = require('./server');
  const actualPort = await startServer(db);

  // Async cleanup of stale worktrees (don't block startup)
  cleanupStaleWorktreesAsync(config);

  // Return the actual port the server started on
  return actualPort;
}

/**
 * Store PR data in database
 * @param {Object} db - Database instance
 * @param {Object} prInfo - PR information
 * @param {Object} prData - PR data from GitHub
 * @param {string} diff - Unified diff content
 * @param {Array} changedFiles - Changed files information
 * @param {string} worktreePath - Worktree path
 */
async function storePRData(db, prInfo, prData, diff, changedFiles, worktreePath) {
  const repository = normalizeRepository(prInfo.owner, prInfo.repo);

  // Begin transaction for atomic database operations
  await run(db, 'BEGIN TRANSACTION');

  try {
    // Store or update worktree record
    const worktreeRepo = new WorktreeRepository(db);
    await worktreeRepo.getOrCreate({
      prNumber: prInfo.number,
      repository,
      branch: prData.head_branch,
      path: worktreePath
    });

    // Prepare extended PR data (keep worktree_path for backward compat, but DB is source of truth)
    const extendedPRData = {
      ...prData,
      diff: diff,
      changed_files: changedFiles,
      worktree_path: worktreePath,
      fetched_at: new Date().toISOString()
    };

    // First check if PR metadata exists
    const existingPR = await queryOne(db, `
      SELECT id FROM pr_metadata WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    if (existingPR) {
      // Update existing PR metadata (preserves ID)
      await run(db, `
        UPDATE pr_metadata
        SET title = ?, description = ?, author = ?,
            base_branch = ?, head_branch = ?, pr_data = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData),
        existingPR.id
      ]);
      console.log(`Updated existing PR metadata (ID: ${existingPR.id})`);
    } else {
      // Insert new PR metadata
      const result = await run(db, `
        INSERT INTO pr_metadata
        (pr_number, repository, title, description, author, base_branch, head_branch, pr_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        prInfo.number,
        repository,
        prData.title,
        prData.body,
        prData.author,
        prData.base_branch,
        prData.head_branch,
        JSON.stringify(extendedPRData)
      ]);
      console.log(`Created new PR metadata (ID: ${result.lastID})`);
    }

    // Create or update review record
    // NOTE: Uses raw SQL instead of ReviewRepository to participate in the surrounding
    // transaction and to update only review_data without overwriting custom_instructions
    // or summary fields that may have been set by previous analysis runs.
    const existingReview = await queryOne(db, `
      SELECT id FROM reviews WHERE pr_number = ? AND repository = ? COLLATE NOCASE
    `, [prInfo.number, repository]);

    if (existingReview) {
      // Update existing review (preserves ID)
      await run(db, `
        UPDATE reviews
        SET review_data = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        }),
        existingReview.id
      ]);
      console.log(`Updated existing review (ID: ${existingReview.id})`);
    } else {
      // Insert new review
      const result = await run(db, `
        INSERT INTO reviews
        (pr_number, repository, status, review_data)
        VALUES (?, ?, 'draft', ?)
      `, [
        prInfo.number,
        repository,
        JSON.stringify({
          worktree_path: worktreePath,
          created_at: new Date().toISOString()
        })
      ]);
      console.log(`Created new review (ID: ${result.lastID})`);
    }

    // Commit transaction
    await run(db, 'COMMIT');
    console.log(`Stored PR data for ${repository} #${prInfo.number}`);

  } catch (error) {
    // Rollback transaction on error
    await run(db, 'ROLLBACK');
    console.error('Error storing PR data:', error);
    throw new Error(`Failed to store PR data: ${error.message}`);
  }
}

/**
 * Category to emoji mapping for AI suggestions
 */
const CATEGORY_EMOJI_MAP = {
  'bug': '🐛',
  'performance': '⚡',
  'design': '📐',
  'code-style': '🧹',
  'improvement': '💡',
  'praise': '⭐',
  'security': '🔒',
  'suggestion': '💬'
};

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
  const emoji = CATEGORY_EMOJI_MAP[category] || '💬';
  // Properly capitalize hyphenated categories (e.g., "code-style" -> "Code Style")
  const capitalizedCategory = category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return `${emoji} **${capitalizedCategory}**: ${text}`;
}

/**
 * Handle draft mode review workflow
 * Runs AI analysis and submits draft review to GitHub without opening browser
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed command line flags
 */
async function handleDraftModeReview(args, config, db, flags = {}) {
  let prInfo = null;

  try {
    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      throw new Error('GitHub token not found. Set GITHUB_TOKEN environment variable or run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    prInfo = await parser.parsePRArguments(args);

    console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo} in draft mode`);

    // Create GitHub client and validate token
    const githubClient = new GitHubClient(githubToken);
    const tokenValid = await githubClient.validateToken();
    if (!tokenValid) {
      throw new Error('GitHub authentication failed. Check your token in ~/.pair-review/config.json');
    }

    // Check if repository is accessible
    const repoExists = await githubClient.repositoryExists(prInfo.owner, prInfo.repo);
    if (!repoExists) {
      throw new Error(`Repository ${prInfo.owner}/${prInfo.repo} not found or not accessible`);
    }

    // Fetch PR data from GitHub
    console.log('Fetching pull request data from GitHub...');
    const prData = await githubClient.fetchPullRequest(prInfo.owner, prInfo.repo, prInfo.number);

    // Get current repository path
    const currentDir = parser.getCurrentDirectory();
    const repository = normalizeRepository(prInfo.owner, prInfo.repo);

    // Register the known repository location for future web UI usage
    await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);

    // Setup git worktree
    console.log('Setting up git worktree...');
    const worktreeManager = new GitWorktreeManager(db);
    const worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, currentDir);

    // Generate unified diff
    console.log('Generating unified diff...');
    const diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
    const changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);

    // Store PR data in database
    console.log('Storing pull request data...');
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath);

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
    const review = await reviewRepo.getOrCreate({ prNumber: prInfo.number, repository });

    // Fetch repo settings to get default instructions
    const repoSettingsRepo = new RepoSettingsRepository(db);
    const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
    const repoInstructions = repoSettings?.default_instructions || null;

    // Run AI analysis
    console.log('Running AI analysis (all 3 levels)...');
    const model = flags.model || process.env.PAIR_REVIEW_MODEL || 'sonnet';
    const analyzer = new Analyzer(db, model);

    let analysisSummary = null;
    try {
      // Pass repo instructions to ensure they're captured in the analysis run
      const analysisResult = await analyzer.analyzeAllLevels(review.id, worktreePath, storedPRData, null, { repoInstructions });
      analysisSummary = analysisResult.summary;
      console.log('AI analysis completed successfully');
    } catch (analysisError) {
      console.error(`AI analysis failed: ${analysisError.message}`);
      console.error('Suggestions (if any) have been saved to the database.');
      console.error('You can run pair-review without --ai-draft to view them in the UI.');
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
      WHERE review_id = ? AND source = 'ai' AND ai_level IS NULL AND status = 'active'
      ORDER BY file, line_start
    `, [review.id]);

    console.log(`Found ${aiSuggestions.length} AI suggestions to submit`);

    if (aiSuggestions.length === 0) {
      console.log('No AI suggestions to submit. Exiting without creating draft review.');
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
      console.log('No suggestions with valid line information. Exiting without creating draft review.');
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
    const reviewBody = analysisSummary
      ? `## AI Analysis Summary

${analysisSummary}

> Generated by [pair-review](https://github.com/in-the-loop-labs/pair-review) with \`--ai-draft\` mode`
      : `## AI Analysis Summary

Found ${validSuggestions.length} suggestion${validSuggestions.length === 1 ? '' : 's'} from automated analysis.

> Generated by [pair-review](https://github.com/in-the-loop-labs/pair-review) with \`--ai-draft\` mode`;

    // Submit draft review to GitHub via GraphQL (same path as web UI)
    console.log(`Submitting draft review with ${githubComments.length} comments...`);

    const prNodeId = storedPRData.node_id;
    if (!prNodeId) {
      throw new Error(`PR node_id not available for ${prInfo.owner}/${prInfo.repo}#${prInfo.number}. Cannot submit draft review without GraphQL node ID.`);
    }

    // Check for existing pending draft (GitHub only allows one per user per PR)
    const existingDraft = await githubClient.getPendingReviewForUser(
      prInfo.owner, prInfo.repo, prInfo.number
    );

    const githubReview = await githubClient.createDraftReviewGraphQL(
      prNodeId, reviewBody, githubComments, existingDraft?.id
    );

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

    // Update database to track the draft review
    await run(db, 'BEGIN TRANSACTION');

    try {
      const now = new Date().toISOString();
      const reviewData = {
        github_node_id: githubNodeId,
        github_url: githubReview.html_url,
        event: 'DRAFT',
        body: reviewBody || '',
        comments_count: githubReview.comments_count,
        created_at: now
      };

      // Update review record via repository method
      // Uses UPDATE (not INSERT OR REPLACE) to avoid cascade deletion of comments/analysis_runs
      await reviewRepo.updateAfterSubmission(review.id, {
        event: 'DRAFT',
        reviewData: reviewData
      });

      // Create a github_reviews record to track this submission (matches pr.js)
      const githubReviewRepo = new GitHubReviewRepository(db);
      await githubReviewRepo.create(review.id, {
        github_review_id: githubDatabaseId,
        github_node_id: githubNodeId,
        state: 'pending',
        body: reviewBody || '',
        github_url: githubReview.html_url
      });

      // Update AI suggestions to 'draft' status (batch update for performance)
      if (aiSuggestions.length > 0) {
        const suggestionIds = aiSuggestions.map(s => s.id);
        const placeholders = suggestionIds.map(() => '?').join(',');
        await run(db, `
          UPDATE comments
          SET status = 'draft', updated_at = ?
          WHERE id IN (${placeholders})
        `, [now, ...suggestionIds]);
      }

      await run(db, 'COMMIT');

      console.log(`\n✅ Draft review created successfully!`);
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
    process.exit(1);
  }
}

/**
 * Handle GitHub Action review mode.
 * Similar to draft mode but:
 * - Supports --use-checkout to skip worktree creation
 * - Submits as COMMENT (not DRAFT) by default
 * - Supports --output-json for structured output
 * - Supports --fail-on-issues for CI failure on issues
 *
 * @param {Array<string>} args - Command line arguments
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed command line flags
 */
async function handleActionReview(args, config, db, flags = {}) {
  let prInfo = null;

  try {
    // Get GitHub token (env var takes precedence over config)
    const githubToken = getGitHubToken(config);
    if (!githubToken) {
      throw new Error('GitHub token not found. Set GITHUB_TOKEN environment variable or run: npx pair-review --configure');
    }

    // Parse PR arguments
    const parser = new PRArgumentParser();
    prInfo = await parser.parsePRArguments(args);

    console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo} in action review mode`);

    // Create GitHub client and validate token
    const githubClient = new GitHubClient(githubToken);
    const tokenValid = await githubClient.validateToken();
    if (!tokenValid) {
      throw new Error('GitHub authentication failed. Check your GITHUB_TOKEN');
    }

    // Check if repository is accessible
    const repoExists = await githubClient.repositoryExists(prInfo.owner, prInfo.repo);
    if (!repoExists) {
      throw new Error(`Repository ${prInfo.owner}/${prInfo.repo} not found or not accessible`);
    }

    // Fetch PR data from GitHub
    console.log('Fetching pull request data from GitHub...');
    const prData = await githubClient.fetchPullRequest(prInfo.owner, prInfo.repo, prInfo.number);

    const repository = `${prInfo.owner}/${prInfo.repo}`;
    let worktreePath;
    let diff;
    let changedFiles;

    // Determine working directory: --use-checkout uses current directory
    if (flags.useCheckout) {
      worktreePath = process.cwd();
      console.log(`Using current checkout at ${worktreePath}`);

      // Generate diff directly from current checkout
      console.log('Generating unified diff from checkout...');
      const simpleGit = require('simple-git');
      const git = simpleGit(worktreePath);

      // Ensure we have the base SHA available (fetch if needed)
      try {
        await git.fetch(['origin', prData.base_sha, '--depth=1']);
      } catch (fetchError) {
        // Fetch might fail if already available, that's ok
        console.log(`Fetch note: ${fetchError.message}`);
      }

      diff = await git.diff([`${prData.base_sha}...${prData.head_sha}`, '--unified=3']);

      // Get changed files
      const diffSummary = await git.diffSummary([`${prData.base_sha}...${prData.head_sha}`]);
      const { getGeneratedFilePatterns } = require('./git/gitattributes');
      const gitattributes = await getGeneratedFilePatterns(worktreePath);

      changedFiles = diffSummary.files.map(file => ({
        file: file.file,
        insertions: file.insertions,
        deletions: file.deletions,
        changes: file.changes,
        binary: file.binary || false,
        generated: gitattributes.isGenerated(file.file)
      }));
    } else {
      // Use worktree approach (same as draft mode)
      const currentDir = parser.getCurrentDirectory();
      await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);

      console.log('Setting up git worktree...');
      const worktreeManager = new GitWorktreeManager(db);
      worktreePath = await worktreeManager.createWorktreeForPR(prInfo, prData, currentDir);

      console.log('Generating unified diff...');
      diff = await worktreeManager.generateUnifiedDiff(worktreePath, prData);
      changedFiles = await worktreeManager.getChangedFiles(worktreePath, prData);
    }

    // Store PR data in database
    console.log('Storing pull request data...');
    await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath);

    // Get PR metadata ID for AI analysis
    const prMetadata = await queryOne(db, `
      SELECT id, pr_data FROM pr_metadata
      WHERE pr_number = ? AND repository = ?
    `, [prInfo.number, repository]);

    if (!prMetadata) {
      throw new Error('Failed to retrieve stored PR metadata');
    }

    const storedPRData = JSON.parse(prMetadata.pr_data);

    // Get or create a review record for this PR
    const reviewRepo = new ReviewRepository(db);
    const review = await reviewRepo.getOrCreate({ prNumber: prInfo.number, repository });

    // Run AI analysis
    console.log('Running AI analysis (all 3 levels)...');
    const model = flags.model || process.env.PAIR_REVIEW_MODEL || 'sonnet';
    const analyzer = new Analyzer(db, model);

    let analysisSummary = null;
    try {
      const analysisResult = await analyzer.analyzeAllLevels(review.id, worktreePath, storedPRData);
      analysisSummary = analysisResult.summary;
      console.log('AI analysis completed successfully');
    } catch (analysisError) {
      console.error(`AI analysis failed: ${analysisError.message}`);
      throw new Error(`AI analysis failed: ${analysisError.message}`);
    }

    // Query for final AI suggestions (orchestrated, not per-level)
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
      WHERE review_id = ? AND source = 'ai' AND ai_level IS NULL AND status = 'active'
      ORDER BY file, line_start
    `, [review.id]);

    console.log(`Found ${aiSuggestions.length} AI suggestions to submit`);

    if (aiSuggestions.length === 0) {
      console.log('✅ No AI suggestions to submit. Review completed with no issues found.');
      return; // Exit gracefully
    }

    // Filter out suggestions without valid line information
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
      console.log('✅ No suggestions with valid line information. Exiting without creating review.');
      return;
    }

    // Format AI suggestions for GitHub
    const githubComments = validSuggestions.map(suggestion => {
      const formattedBody = formatAISuggestion(suggestion.body, suggestion.type);
      return {
        path: suggestion.file,
        line: suggestion.line_start,
        body: formattedBody,
        diff_position: null
      };
    });

    // Build review body with AI-generated summary
    const reviewBody = analysisSummary
      ? `## AI Analysis Summary

${analysisSummary}

> Generated by [pair-review](https://github.com/in-the-loop-labs/pair-review) with \`--ai-review\` mode`
      : `## AI Analysis Summary

Found ${validSuggestions.length} suggestion${validSuggestions.length === 1 ? '' : 's'} from automated analysis.

> Generated by [pair-review](https://github.com/in-the-loop-labs/pair-review) with \`--ai-review\` mode`;

    // Submit review to GitHub as COMMENT (not DRAFT)
    console.log(`Submitting review with ${githubComments.length} comments...`);

    const diffContent = storedPRData.diff || '';

    const githubReview = await githubClient.createReview(
      prInfo.owner,
      prInfo.repo,
      prInfo.number,
      'COMMENT',  // Submit immediately, not as draft
      reviewBody,
      githubComments,
      diffContent
    );

    // Update database to track the review
    await run(db, 'BEGIN TRANSACTION');

    try {
      const now = new Date().toISOString();
      const reviewData = {
        github_review_id: githubReview.id,
        github_url: githubReview.html_url,
        event: 'COMMENT',
        body: reviewBody,
        comments_count: githubReview.comments_count,
        created_at: now
      };

      await run(db, `
        INSERT OR REPLACE INTO reviews (pr_number, repository, status, review_id, updated_at, review_data)
        VALUES (?, ?, 'submitted', ?, ?, ?)
      `, [prInfo.number, repository, githubReview.id, now, JSON.stringify(reviewData)]);

      // Update AI suggestions to 'submitted' status
      if (aiSuggestions.length > 0) {
        const suggestionIds = aiSuggestions.map(s => s.id);
        const placeholders = suggestionIds.map(() => '?').join(',');
        await run(db, `
          UPDATE comments
          SET status = 'submitted', updated_at = ?
          WHERE id IN (${placeholders})
        `, [now, ...suggestionIds]);
      }

      await run(db, 'COMMIT');

      console.log(`\n✅ Review submitted successfully!`);
      console.log(`   Review URL: ${githubReview.html_url}`);
      console.log(`   Comments submitted: ${githubReview.comments_count}\n`);

      // Exit with code 2 if --fail-on-issues and issues were found
      if (flags.failOnIssues && validSuggestions.length > 0) {
        console.log('Exiting with code 2 due to --fail-on-issues flag');
        process.exit(2);
      }

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
      console.error('Please check your GITHUB_TOKEN\n');
    } else if (error.message && error.message.includes('Repository') && error.message.includes('not found')) {
      console.error(`\n❌ ${error.message}`);
      console.error('Please check the repository name and your access permissions.\n');
    } else if (error.message && error.message.includes('Network error')) {
      console.error('\n❌ Network connection error');
      console.error('Please check your internet connection and try again.\n');
    } else {
      console.error(`\n❌ Error: ${error.message}\n`);
    }

    process.exit(1);
  }
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

module.exports = { main, parseArgs };