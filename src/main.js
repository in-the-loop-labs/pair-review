// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { loadConfig, getConfigDir, showWelcomeMessage, resolveDbName, resolveRepoOptions, resolvePoolConfig, getRepoResetScript, resolveLoadSkills, buildCouncilProviderOverrides } = require('./config');
const { initializeDatabase, run, queryOne, query, migrateExistingWorktrees, WorktreeRepository, ReviewRepository, RepoSettingsRepository, GitHubReviewRepository, WorktreePoolRepository, CouncilRepository, CommentRepository, AnalysisRunRepository } = require('./database');
const { PRArgumentParser } = require('./github/parser');
const { GitHubClient } = require('./github/client');
const { GitWorktreeManager } = require('./git/worktree');
const { fetchNoTags } = require('./git/fetch-helpers');
const { WorktreePoolLifecycle } = require('./git/worktree-pool-lifecycle');
const { startServer } = require('./server');
const Analyzer = require('./ai/analyzer');
const { applyConfigOverrides } = require('./ai');
const { handleLocalReview, findMainGitRoot, setupLocalReviewSession, findGitRoot, findMergeBase, getRepositoryName } = require('./local-review');
const { resolveCliInstructions, prepareInteractiveAnalysisConfig } = require('./interactive-analysis-config');
const { resolveCouncilHandle, getCouncilLastUsedRepos, shortId } = require('./councils/resolve-council');
const { runHeadlessCouncilAnalysis } = require('./councils/headless-council');
const { normalizeCouncilConfig, validateCouncilConfig } = require('./routes/councils');
const { resolveReviewConfig } = require('./review-config');
const { redirectConsoleToStderr } = require('./mcp-stdio');
const { getChangedFiles } = require('./routes/executable-analysis');
const { safeParseJson } = require('./utils/safe-parse-json');
const { includesBranch } = require('./local-scope');
const { storePRData, resolvePrHostBinding, registerRepositoryLocation, findRepositoryPath } = require('./setup/pr-setup');
const { isDualHostRepo, resolvePreflightBinding, hostSetupParamValue } = require('./utils/host-resolution');
const { fireReviewStartedHook } = require('./hooks/payloads');
const { normalizeRepository, resolveRenamedFile, resolveRenamedFileOld } = require('./utils/paths');
const { rejectUrlLikeLocalReviewPath } = require('./utils/local-path-input');
const logger = require('./utils/logger');
const simpleGit = require('simple-git');
const { getGeneratedFilePatterns } = require('./git/gitattributes');
const { GIT_DIFF_FLAGS_ARRAY, GIT_DIFF_SUMMARY_FLAGS_ARRAY } = require('./git/diff-flags');
const { getEmoji: getCategoryEmoji } = require('./utils/category-emoji');
const open = (...args) => process.env.PAIR_REVIEW_NO_OPEN ? Promise.resolve() : import('open').then(({default: open}) => open(...args));
const { registerProtocolHandler, unregisterProtocolHandler } = require('./protocol-handler');
const { attemptDelegation } = require('./single-port');

let db = null;

/**
 * Build a user-facing "missing token" error message tailored to the
 * resolved host binding.
 *
 * For github.com bindings (`apiHost === null`), suggest the legacy
 * options: `GITHUB_TOKEN` env var, `config.github_token`, or
 * `config.github_token_command`. For alt-host bindings, suppress those
 * suggestions (the github.com top-level credentials are intentionally
 * not used for alt-hosts) and point exclusively at the per-repo
 * `token` / `token_command` keys under the resolved bindingRepository.
 *
 * @param {Object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.bindingRepository - The `repos[...]` config key
 *   that the binding lookup was performed against. May differ from
 *   `<owner>/<repo>` for monorepo-style configs (see Fix #8).
 * @param {string|null} params.apiHost - Resolved api_host (null = github.com)
 * @returns {string}
 */
function buildMissingTokenError({ owner, repo, bindingRepository, apiHost }) {
  if (apiHost) {
    return (
      `GitHub token not found for alt-host repo ${owner}/${repo} (${apiHost}). ` +
      `GITHUB_TOKEN and top-level github_token/github_token_command are github.com-only ` +
      `and are not used for alt-hosts. Configure ` +
      `\`config.repos["${bindingRepository}"].token\` or ` +
      `\`config.repos["${bindingRepository}"].token_command\` ` +
      `(e.g., "althost-cli auth token"). Run: npx pair-review --configure`
    );
  }
  return (
    `GitHub token not found for ${owner}/${repo}. ` +
    `Set GITHUB_TOKEN env var, or configure a token at ` +
    `\`config.repos["${bindingRepository}"].token\` or ` +
    `\`config.repos["${bindingRepository}"].token_command\`, or set ` +
    `top-level \`github_token\` / \`github_token_command\` ` +
    `(e.g., "gh auth token"). Run: npx pair-review --configure`
  );
}

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
    --headless              Run AI analysis, store it in the local database, and
                            report the results to stdout/stderr, then exit. No
                            server, no browser, no GitHub post. Works with a
                            <pr> argument or --local.
    --json                  With --headless, emit the completed run plus its
                            consolidated final suggestions as a single JSON
                            document on a clean stdout. For any outcome of the
                            headless run — success, zero findings, or an error
                            raised while running it — stdout carries a JSON
                            document with an "ok" field; on failure that envelope
                            is { "ok": false, "error": ... } and the exit code is
                            non-zero. Pre-flight config/startup failures are the
                            exception: they exit non-zero with a stderr message
                            and no JSON envelope, so branch on the exit code
                            first. stderr is quiet by default (only
                            warnings/errors); add --debug for verbose progress
                            logs. Only valid together with --headless.
    --instructions <text>   Per-run custom instructions for the analysis.
                            Applies to any mode that runs analysis: --headless,
                            --ai, --ai-draft, --ai-review, or --council (with
                            --ai/--council the instructions are carried into the
                            browser-triggered analysis). Default: none.
    --instructions-file <path>
                            Read per-run custom instructions from a file.
                            Mutually exclusive with --instructions.
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
                            also: fable-5-xhigh, fable-5-high, opus-4.8-xhigh,
                                  opus-4.8-high, opus-4.7-xhigh, opus-4.7-high,
                                  opus-4.6-high, opus-4.6-1m, sonnet-5-xhigh,
                                  sonnet-5-high, sonnet-4.6
                            (opus is Opus 4.8 XHigh, the default)
                            or use provider-specific models with Antigravity/Codex
    --provider <name>       Override the AI provider for headless modes
                            (--ai-draft / --ai-review). Defaults to the
                            repo/app default provider (claude). Pair with
                            --model when the model belongs to a non-default
                            provider (e.g. --provider codex --model gpt-5.5).
                            Available: claude, antigravity, codex, copilot,
                            opencode, cursor-agent, pi
    --council <handle>      Run analysis with a saved council (multi-voice). Handle is a
                            council name, name-slug, or id (prefix). See --list-councils.
    --list-councils         List saved councils (handles to use with --council) and exit
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
    pair-review 123 --ai-draft --council security-review  # Headless council draft
    pair-review --local --headless --json   # Analyze local changes, emit JSON, exit
    pair-review 123 --headless              # Analyze a PR, print a summary, exit
    pair-review --local --headless --council security  # Headless council analysis
    pair-review --list-councils        # List saved councils and their handles
    pair-review --register                     # Register URL scheme handler
    pair-review --register --command "node bin/pair-review.js"  # Custom command

ENVIRONMENT VARIABLES:
    GITHUB_TOKEN            GitHub Personal Access Token (takes precedence over config file)
    PAIR_REVIEW_CLAUDE_CMD  Custom command to invoke Claude CLI (default: claude)
    PAIR_REVIEW_ANTIGRAVITY_CMD  Custom command to invoke Antigravity CLI (default: agy)
    PAIR_REVIEW_CODEX_CMD   Custom command to invoke Codex CLI (default: codex)
    PAIR_REVIEW_MODEL       Override the AI model (same as --model flag, default: opus)
    PAIR_REVIEW_PROVIDER    Override the AI provider (same as --provider flag, default: claude)

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
 * Print the list of saved councils (handles, names, types, and "last used"
 * metadata) as an aligned table, then exit guidance. Used by --list-councils.
 *
 * @param {Object} db - Database instance
 */
async function printCouncilList(db) {
  const councils = await new CouncilRepository(db).list();

  if (!councils || councils.length === 0) {
    console.log('No councils found. Create one in the web UI under Analysis settings.');
    return;
  }

  const repoMap = await getCouncilLastUsedRepos(db);

  const rows = councils.map(c => {
    const entry = repoMap.get(c.id);
    const lastTs = entry?.last_started || c.last_used_at;
    const lastUsed = lastTs ? String(lastTs).slice(0, 10) : 'never';
    let lastUsedWith = '—';
    if (entry) {
      lastUsedWith = `${entry.repository}${entry.pr_number ? `#${entry.pr_number}` : ''}`;
    }
    return {
      handle: shortId(c.id),
      name: c.name || '',
      type: c.type || '',
      lastUsed,
      lastUsedWith
    };
  });

  const headers = {
    handle: 'HANDLE',
    name: 'NAME',
    type: 'TYPE',
    lastUsed: 'LAST USED',
    lastUsedWith: 'LAST USED WITH'
  };

  const widths = {};
  for (const key of Object.keys(headers)) {
    widths[key] = Math.max(
      headers[key].length,
      ...rows.map(r => String(r[key]).length)
    );
  }

  const formatRow = r =>
    [
      String(r.handle).padEnd(widths.handle),
      String(r.name).padEnd(widths.name),
      String(r.type).padEnd(widths.type),
      String(r.lastUsed).padEnd(widths.lastUsed),
      String(r.lastUsedWith).padEnd(widths.lastUsedWith)
    ].join('  ');

  console.log(formatRow(headers));
  for (const r of rows) {
    console.log(formatRow(r));
  }

  console.log('');
  console.log('Pass a handle with --council, e.g.:');
  console.log('  pair-review <pr> --ai-draft --council ' + shortId(councils[0].id));
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
  '--headless',
  '--json',
  '--instructions',
  '--instructions-file',
  '--configure',
  '-d', '--debug',
  '--debug-stream',
  '-h', '--help',
  '-l', '--local',
  '--mcp',
  '--model',
  '--provider',
  '--council',
  '--list-councils',
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
    } else if (arg === '--headless') {
      flags.headless = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--instructions') {
      // Next argument is free-text instructions. Unlike --model/--council, the
      // value may legitimately begin with '-' (free text), so we only require
      // that a token follows — we do NOT apply the !startsWith('-') guard.
      if (i + 1 < args.length) {
        flags.instructions = args[i + 1];
        i++; // Skip next argument since we consumed it
      } else {
        throw new Error('--instructions flag requires a text value (e.g., --instructions "focus on error handling")');
      }
    } else if (arg === '--instructions-file') {
      // Next argument is a file path. A path won't legitimately start with '-',
      // so apply the same guard as --model to catch a missing value early.
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.instructionsFile = args[i + 1];
        i++; // Skip next argument since we consumed it
      } else {
        throw new Error('--instructions-file flag requires a file path (e.g., --instructions-file ./review-notes.txt)');
      }
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
    } else if (arg === '--provider') {
      // Next argument is the provider name
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.provider = args[i + 1];
        i++; // Skip next argument since we consumed it
      } else {
        throw new Error('--provider flag requires a provider name (e.g., --provider codex)');
      }
    } else if (arg === '--council') {
      // Next argument is the council handle (name, name-slug, or id prefix)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.council = args[i + 1];
        i++; // Skip next argument since we consumed it
      } else {
        throw new Error('--council flag requires a council handle (e.g., --council my-council)');
      }
    } else if (arg === '--list-councils') {
      flags.listCouncils = true;
    } else if (arg === '-l' || arg === '--local') {
      // -l/--local flag is always a boolean
      flags.local = true;
      // Next argument is optional path (if not starting with -)
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        rejectUrlLikeLocalReviewPath(args[i + 1]);
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
    PAIR_REVIEW_ANTIGRAVITY_CMD  Custom Antigravity CLI command (default: agy)
    PAIR_REVIEW_CODEX_CMD   Custom Codex CLI command (default: codex)
    PAIR_REVIEW_MODEL       Default AI model (e.g., opus, sonnet, haiku)
    PAIR_REVIEW_DB_NAME     Custom database filename (overrides config)

LOCAL CONFIG:
    Place a .pair-review/config.json in your working directory to override
    global settings (e.g., db_name for per-worktree database isolation).

AI PROVIDERS:
    Claude (default): Requires 'claude' CLI installed
    Antigravity: Requires 'agy' CLI installed
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

    // In headless --json mode, stdout is reserved for the single JSON document,
    // so lock it down as EARLY as possible — before loadConfig() (which on a
    // genuine first run creates the config dir and can log) and before the
    // first-run welcome box below, both of which would otherwise corrupt the
    // JSON. Peek the raw args here: neither flag takes a value, parseArgs() still
    // runs afterwards for full validation, and redirectConsoleToStderr() is
    // idempotent (it only reassigns console.* / the logger stream), so the later
    // gated call is unnecessary once this fires.
    //
    // Quiet by default: --headless --json is consumed mostly by coding agents,
    // whose shell tools capture stderr into context — so we DROP progress
    // narration rather than relocating it to stderr (warnings/errors still emit).
    // --debug/-d restores the full verbose stderr stream for humans diagnosing a
    // run. parseArgs() hasn't run yet, so peek raw args for the debug flags too.
    const isHeadlessJson = args.includes('--headless') && args.includes('--json');
    if (isHeadlessJson) {
      const wantsDebug = args.includes('-d') || args.includes('--debug');
      redirectConsoleToStderr({ quiet: !wantsDebug });
    }

    // Load configuration
    const { config, isFirstRun } = await loadConfig();

    // Show welcome message on first run (after early-exit flags are handled
    // above). Suppressed in headless --json mode so nothing reaches stdout but
    // the JSON document.
    if (isFirstRun && !isHeadlessJson) {
      showWelcomeMessage();
    }

    // Parse command line arguments including flags (before DB init so
    // single-port delegation can skip DB entirely)
    const { prArgs, flags } = parseArgs(args);

    // Headless-mode flag validation (fail fast, before any DB/server work).
    // --instructions and --instructions-file are mutually exclusive.
    if (flags.instructions && flags.instructionsFile) {
      throw new Error('--instructions and --instructions-file are mutually exclusive; provide only one.');
    }
    // --json only makes sense as the machine-readable sink for --headless.
    if (flags.json && !flags.headless) {
      throw new Error('--json requires --headless (it emits the headless run as JSON).');
    }
    // --headless needs something to analyze: a PR identifier or --local.
    if (flags.headless && prArgs.length === 0 && !flags.local) {
      throw new Error('--headless flag requires a pull request number/URL or --local to run analysis.');
    }
    // --instructions[-file] only takes effect in a mode that actually runs
    // analysis. Plain interactive mode never auto-analyzes, so reject the
    // orphaned case with a clear message rather than silently dropping the text
    // (the failure mode this flag's parity is meant to avoid). The consuming
    // modes are: --headless / --ai-draft / --ai-review (consume directly) and
    // --ai / --council (threaded to the browser via analysisConfigId).
    if (
      (flags.instructions || flags.instructionsFile) &&
      !(flags.headless || flags.aiDraft || flags.aiReview || flags.ai || flags.council)
    ) {
      throw new Error(
        '--instructions/--instructions-file require a mode that runs analysis: ' +
        '--headless, --ai, --ai-draft, --ai-review, or --council.'
      );
    }

    // NOTE: in headless --json mode, stdout was already redirected to stderr
    // above (before loadConfig + the first-run welcome) — see `isHeadlessJson`.
    // No redirect is repeated here: it would be too late to matter and is
    // redundant given the early call.

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

    // --model is ignored when --council is set: council voices use their own
    // per-voice models, so a top-level --model has no effect on the analysis.
    if (flags.council && flags.model) {
      console.warn('Warning: --model is ignored when --council is set; council voices use their own per-voice models.');
    }

    // Apply provider config overrides (including yolo) for all code paths
    // (interactive, headless, local). server.js calls this independently on
    // startup, but headless paths (--ai-draft, --ai-review) never start the
    // server, so we must also apply here.
    applyConfigOverrides(config);

    // --list-councils: print the saved councils and exit. Needs the database
    // but no server, no PR/local context, and no single-port delegation.
    if (flags.listCouncils) {
      const listDb = await initializeDatabase(resolveDbName(config));
      try {
        await printCouncilList(listDb);
      } finally {
        try { listDb.close(); } catch { /* ignore */ }
      }
      process.exit(0);
    }

    // --council requires something to analyze: a PR identifier or --local.
    // Reject early (before single-port delegation) so a contextless `--council`
    // fails fast with a clear message instead of silently delegating to — or
    // starting — the generic landing page with the council ignored.
    //
    // Exception: in GitHub Actions, `--ai-review --council <handle>` is a
    // documented headless flow where the PR is auto-detected from the
    // environment further below (detectPRFromGitHubEnvironment). At this point
    // prArgs is still empty, so guarding on it alone would reject that valid CI
    // invocation. Defer to the later `--ai-review` PR check, which reports a
    // clear error if no PR can be detected.
    if (
      flags.council &&
      prArgs.length === 0 &&
      !flags.local &&
      !(flags.aiReview && process.env.GITHUB_ACTIONS === 'true')
    ) {
      throw new Error('--council flag requires a pull request number/URL or --local to run analysis');
    }

    // Resolve the council handle FAIL-FAST, before single-port delegation, so
    // that (a) a bad handle errors out for every mode (interactive, headless,
    // and delegated) rather than only on a cold start, and (b) the resolved id
    // can be threaded into the delegated URL — the browser-side council
    // auto-analysis is keyed on the `council` query param. Resolution needs the
    // DB, so when --council is set we open the shared connection now and the
    // downstream handlers reuse it (they re-resolve for their own purposes;
    // that is a cheap in-memory match against the same connection).
    let cliCouncil = null;
    if (flags.council) {
      db = await initializeDatabase(resolveDbName(config));
      cliCouncil = await resolveCouncilHandle(db, flags.council);
    }

    // Single-port delegation: if a pair-review server is already running on the
    // configured port, delegate to it (open browser URL) and exit immediately.
    // Skipped for: headless modes (no browser), single_port: false (dev mode).
    // --headless never delegates/opens a browser — it runs analysis locally and
    // reports to stdout/stderr.
    if (config.single_port !== false && !flags.aiReview && !flags.aiDraft && !flags.headless) {
      // Carry --instructions across delegation. When an analyzing mode
      // (--ai/--council) ALSO supplies per-run instructions and a server is
      // already running, attemptDelegation resolves the analysis config and POSTs
      // it to that (separate) process, threading the returned id as
      // `analysisConfigId`. That handoff needs an open DB (repo-default/council
      // resolution) and, for local mode, the repository name — PR mode derives it
      // from the args inside attemptDelegation. Without instructions this is a
      // no-op and the prior councilId/analyze URL shape is preserved.
      const wantsInstructionHandoff =
        (flags.instructions || flags.instructionsFile) && (flags.ai || flags.council);
      if (wantsInstructionHandoff && !db) {
        db = await initializeDatabase(resolveDbName(config));
      }
      let localRepository = null;
      if (wantsInstructionHandoff && flags.local) {
        const localTarget = require('path').resolve(flags.localPath || process.cwd());
        const localRoot = await findGitRoot(localTarget);
        localRepository = await getRepositoryName(localRoot);
      }

      const delegated = await attemptDelegation(config, flags, prArgs, undefined, {
        councilId: cliCouncil?.id || null,
        db,
        localRepository
      });
      if (delegated) {
        if (db) { try { db.close(); } catch { /* ignore */ } }
        process.exit(0);
      }
      // Not delegated — no server running, proceed to start one
    }

    // Initialize database (reuse the connection already opened for council
    // resolution above, if any).
    if (!db) {
      console.log('Initializing database...');
      db = await initializeDatabase(resolveDbName(config));
    }

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

    // Headless analysis mode: run analysis (single or council), store in the DB,
    // report results to stdout/stderr, and exit. No server, no browser, no GitHub
    // post. Works with a PR arg or --local. Handled before the local/PR split.
    if (flags.headless) {
      await handleHeadlessAnalysis(prArgs, config, db, flags, poolLifecycle);
      return;
    }

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
    // In headless --json mode the consumer (typically a coding agent) parses
    // stdout as JSON. A prose error on stderr + empty stdout forces it to scrape
    // English to learn what broke, so emit a structured failure envelope on
    // stdout instead — one stream, JSON for success and failure alike. Read
    // process.argv directly: `args`/`flags` are block-scoped to the try and
    // unavailable here, and the throw may even predate parseArgs(). Exit stays
    // non-zero so exit-code consumers are unaffected.
    const argv = process.argv.slice(2);
    const jsonMode = argv.includes('--headless') && argv.includes('--json');
    if (jsonMode) {
      // Canonical source for local-mode detection is parseArgs' -l/--local
      // handling; we re-check argv here only because `flags` is block-scoped to
      // the try and may not exist yet if the throw predates parseArgs. Keep any
      // future local-mode alias in sync with that handling. Mode is best-effort
      // (agents branch on `ok`, not `mode`).
      const mode = (argv.includes('--local') || argv.includes('-l')) ? 'local' : 'pr';
      // stdout may be a pipe (e.g. `pair-review … | jq`); a synchronous
      // process.exit() can truncate a buffered write, so exit only once the
      // envelope has flushed. The non-JSON branch below keeps the immediate exit.
      process.stdout.write(
        JSON.stringify(buildHeadlessErrorJson({ mode, error }), null, 2) + '\n',
        () => process.exit(1)
      );
      return;
    }
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
    // Parse PR arguments FIRST — pass config so url_pattern matching for
    // alternate hosts can resolve pasted URLs to the canonical
    // owner/repo before falling back to GitHub/Graphite parsers.
    // We must know the target repo before resolving its token, so that
    // repo-scoped tokens, repo-scoped token_command entries, and alt-host
    // configurations are honored. A no-repository token preflight only
    // sees env + top-level credentials and would reject valid configs.
    const parser = new PRArgumentParser(config);
    const prInfo = await parser.parsePRArguments(args);

    // Resolve token via repo-aware host binding so alt-host and
    // repo-scoped credentials are respected. When a per-repo
    // `url_pattern` matched, prefer its `bindingRepository` — that's the
    // matched `repos[...]` config key, which may differ from the
    // captured `${owner}/${repo}` for monorepo-style patterns.
    const repositoryForBinding = prInfo.bindingRepository
      || normalizeRepository(prInfo.owner, prInfo.repo);
    // A pasted URL tells us the host up front (alt-host `url_pattern` match →
    // api_host string; github/graphite URL → null), so preflight the token
    // against that host. A bare number leaves host undefined → ambiguity rule,
    // but a dual repo with only an alt token is still usable (the setup probe
    // tries the alt host first) — resolvePreflightBinding tolerates that.
    const binding = resolvePreflightBinding(repositoryForBinding, config, prInfo.host);
    if (!binding.token) {
      throw new Error(buildMissingTokenError({
        owner: prInfo.owner,
        repo: prInfo.repo,
        bindingRepository: repositoryForBinding,
        apiHost: binding.apiHost
      }));
    }

    // Register cwd as known repo path if it matches the target repo
    const currentDir = parser.getCurrentDirectory();
    const isMatchingRepo = await parser.isMatchingRepository(currentDir, prInfo.owner, prInfo.repo);
    if (isMatchingRepo) {
      await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);
    }

    // Set model override if provided via CLI flag. Skipped when --council is
    // set: council voices carry their own per-voice models.
    if (flags.model && !flags.council) {
      process.env.PAIR_REVIEW_MODEL = flags.model;
    }

    // Set provider override if provided via CLI flag. Mirrored into the env
    // var so the web/UI analysis paths (which read PAIR_REVIEW_PROVIDER via
    // getProvider()) honor it too, matching how --model works.
    if (flags.provider) {
      process.env.PAIR_REVIEW_PROVIDER = flags.provider;
    }

    // Resolve the council handle FAIL-FAST before starting the server, so a bad
    // handle surfaces as a clean error (caught below) instead of after the
    // browser has opened.
    let councilSelection = null;
    if (flags.council) {
      councilSelection = await resolveCouncilHandle(db, flags.council);
    }

    // Start server and open browser to setup page
    const port = await startServer(db, poolLifecycle);

    // Async cleanup of stale worktrees and reviews (don't block startup)
    cleanupStaleWorktreesAsync(config);
    cleanupStaleReviewsAsync(config);
    startPoolBackgroundFetches(db, config);

    let url = `http://localhost:${port}/pr/${prInfo.owner}/${prInfo.repo}/${prInfo.number}`;
    const shouldAnalyze = flags.ai || flags.council;
    if (shouldAnalyze) url += '?analyze=true';
    // When the run carries --instructions, stash the resolved analysis config
    // (provider/model or council snapshot + instructions) and thread its id so
    // the browser-side auto-analyze honors the instructions instead of silently
    // dropping them. The id already encodes the council selection, so prefer it
    // over the bare &council= param; fall back to &council= otherwise.
    const repository = normalizeRepository(prInfo.owner, prInfo.repo);
    const analysisConfigId = shouldAnalyze
      ? await prepareInteractiveAnalysisConfig({ db, config, flags, repository })
      : null;
    if (analysisConfigId) {
      url += `&analysisConfigId=${analysisConfigId}`;
    } else if (councilSelection) {
      url += `&council=${councilSelection.id}`;
    }

    // Thread the pasted URL's host to setup so it binds directly instead of
    // probing (shared mapping — see hostSetupParamValue): an alt-host string
    // forwards the api_host; a github URL on a DUAL repo forwards the 'github'
    // sentinel; bare numbers / plain / exclusive repos omit it.
    const hostParam = hostSetupParamValue(prInfo.host, isDualHostRepo(config, repositoryForBinding));
    if (hostParam) {
      url += (url.includes('?') ? '&' : '?') + `host=${encodeURIComponent(hostParam)}`;
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
    // Parse PR arguments — pass config so url_pattern matching for
    // alternate hosts can resolve pasted URLs to the canonical
    // owner/repo before falling back to GitHub/Graphite parsers.
    const parser = new PRArgumentParser(config);
    prInfo = await parser.parsePRArguments(args);

    // Resolve + validate the council FAIL-FAST, before any worktree/network
    // work, so a bad handle or invalid config surfaces immediately. The actual
    // council selection used for analysis is produced below by
    // resolveReviewConfig; this is a pre-flight validation only.
    if (flags.council) {
      const council = await resolveCouncilHandle(db, flags.council);
      const configType = council.type || 'advanced';
      const councilConfig = normalizeCouncilConfig(council.config, configType);
      // validateCouncilConfig returns an error string, or null when valid.
      const validationError = validateCouncilConfig(councilConfig, configType);
      if (validationError) {
        throw new Error(`Invalid council "${council.name}": ${validationError}`);
      }
    }

    // Resolve host binding for the target repo (handles alt-host).
    // Prefer `bindingRepository` (from url_pattern match) over the raw
    // `${owner}/${repo}` since they can differ when one config entry
    // serves many monorepo-shaped URLs.
    const repositoryForBinding = prInfo.bindingRepository
      || normalizeRepository(prInfo.owner, prInfo.repo);
    // Preflight the token so a missing credential fails fast before any network
    // work. Tolerates a dual repo with only an alt token when the host is
    // unknown (the setup probe tries the alt host first).
    const preflightBinding = resolvePreflightBinding(repositoryForBinding, config, prInfo.host);
    if (!preflightBinding.token) {
      throw new Error(buildMissingTokenError({
        owner: prInfo.owner,
        repo: prInfo.repo,
        bindingRepository: repositoryForBinding,
        apiHost: preflightBinding.apiHost
      }));
    }

    console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo} in ${options.modeLabel}`);

    // Resolve the per-PR host binding and fetch the PR. Applies host precedence
    // (URL-paste host → stored host → ambiguity/probe for dual repos) and
    // returns the chosen binding so its host is stamped by storePRData below.
    console.log('Fetching pull request data from GitHub...');
    const { binding: headlessBinding, prData, githubClient } = await resolvePrHostBinding({
      db, config, bindingRepository: repositoryForBinding,
      owner: prInfo.owner, repo: prInfo.repo, prNumber: prInfo.number,
      // Only forward a github.com token as the github fallback; if the preflight
      // resolved an ALT binding (dual repo, alt-only token), there is no github
      // fallback token, so pass '' rather than sending the alt token to github.com.
      host: prInfo.host, githubToken: preflightBinding.apiHost === null ? preflightBinding.token : ''
    });
    const githubToken = headlessBinding.token || preflightBinding.token;

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
        await fetchNoTags(git, ['origin', prData.base_sha]);
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
        // Config lookups must use the binding key (matched `repos[...]` entry), not the PR identity.
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
        const resolved = resolveRepoOptions(config, repositoryForBinding, repoSettings);
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
          bindingRepository: repositoryForBinding,
          prNumber: prInfo.number,
          config,
          cloneUrl: prData?.repository?.clone_url,
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
        // (binding key, not PR identity).
        const repoSettingsRepo = new RepoSettingsRepository(db);
        const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
        const { poolSize: resolvedPoolSize, poolFetchIntervalMinutes: _resolvedFetchInterval } = resolvePoolConfig(config, repositoryForBinding, repoSettings);
        poolSize = resolvedPoolSize || 0;
        resetScript = config ? getRepoResetScript(config, repositoryForBinding) : null;
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
      skipWorktreeRecord: !!flags.useCheckout,
      host: headlessBinding.host
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

    // Resolve per-run custom instructions from --instructions/--instructions-file.
    // Default stays null, preserving prior --ai-draft/--ai-review behavior.
    const requestInstructions = await resolveCliInstructions(flags);
    const instructions = { globalInstructions, repoInstructions, requestInstructions };

    // Resolve the review configuration (council vs single provider/model) via the
    // shared resolver, so --ai-draft/--ai-review honor repo default councils too.
    // The early councilSelection above already fail-fast validated an explicit
    // --council; resolveReviewConfig re-resolves the same handle (cheap in-memory
    // match) and unifies single/council selection with the headless path.
    // --provider (flags.provider) rides in as an explicit single-model pick; the
    // resolver's ladder (explicit › PAIR_REVIEW_PROVIDER › repo › config › 'claude')
    // delivers the CLI override that commit 662e introduced.
    const reviewConfig = await resolveReviewConfig(
      db,
      repository,
      { council: flags.council, provider: flags.provider, model: flags.model },
      config
    );

    // Single-provider runs honor the repo/global tier-3 load_skills resolution.
    const cliProvider = reviewConfig.type === 'single' ? reviewConfig.provider : null;
    const providerLoadSkills = cliProvider ? config.providers?.[cliProvider]?.load_skills : undefined;
    const loadSkills = resolveLoadSkills(config, repository, repoSettings, providerLoadSkills);
    const providerOverrides = { load_skills: loadSkills };

    let analysisSummary = null;
    try {
      // Pass all instruction levels to ensure they're captured in the analysis run.
      // githubClient is forwarded so the analyzer can pre-fetch existing PR review
      // comments when callers opt in via excludePrevious.github.
      logger.debug(`analyzer githubClient wired for ${prInfo.owner}/${prInfo.repo}#${prInfo.number}`);
      const { result: analysisResult } = await runHeadlessAnalysis(db, config, {
        reviewId: review.id,
        worktreePath,
        prMetadata: storedPRData,
        changedFiles: null,
        repository,
        repoSettings,
        instructions,
        reviewConfig,
        providerOverrides,
        githubClient
      });
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

    // Check for existing pending draft (GitHub only allows one per user per PR)
    const existingDraft = await githubClient.getPendingReviewForUser(
      prInfo.owner, prInfo.repo, prInfo.number
    );

    // GraphQL PR node id is only required when we'll be creating a NEW
    // GraphQL review (no existing draft to reuse) OR adding GraphQL
    // review comments. REST and host-impl configurations address the
    // PR by (owner, repo, prNumber) + numeric review id and ignore
    // prNodeId; reusing an existing GraphQL draft also doesn't need
    // the PR node id because the review node id is sufficient.
    const willCreateNewGraphQLReview =
      headlessBinding.features.review_lifecycle === 'graphql' && !existingDraft;
    const willAddGraphQLComments =
      githubComments.length > 0 && headlessBinding.features.pending_review_comments === 'graphql';
    const needsGraphQLNodeId = willCreateNewGraphQLReview || willAddGraphQLComments;

    if (needsGraphQLNodeId && !storedPRData.node_id) {
      throw new Error(
        `GraphQL PR node id required for ${prInfo.owner}/${prInfo.repo}#${prInfo.number} ` +
        `(features.review_lifecycle = "${headlessBinding.features.review_lifecycle}", ` +
        `pending_review_comments = "${headlessBinding.features.pending_review_comments}"). ` +
        `PR record is missing node_id — refresh the PR data and try again.`
      );
    }

    const prNodeId = storedPRData.node_id ?? null;

    const submitPrContext = {
      owner: prInfo.owner,
      repo: prInfo.repo,
      prNumber: prInfo.number,
      reviewId: existingDraft?.databaseId
    };

    let githubReview;
    if (options.reviewEvent === 'DRAFT') {
      githubReview = await githubClient.createDraftReviewGraphQL(
        prNodeId, reviewBody, githubComments, existingDraft?.id, submitPrContext
      );
    } else {
      githubReview = await githubClient.createReviewGraphQL(
        prNodeId, options.reviewEvent, reviewBody, githubComments, existingDraft?.id, submitPrContext
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
 * Shared single-vs-council analysis dispatch for headless runs.
 *
 * Both `performHeadlessReview` (GitHub-submit modes) and `handleHeadlessAnalysis`
 * (analysis-only headless mode) call this so the single/council branching — and
 * the instruction object threaded into every analyzer path — lives in exactly one
 * place. It only RUNS analysis and returns the run id + analyzer result; it never
 * submits to GitHub or releases pool worktrees (callers own that).
 *
 * The SAME `instructions` object ({ globalInstructions, repoInstructions,
 * requestInstructions }) is passed to both branches, centralizing the
 * three-analyzer-paths instruction hazard (analyzeAllLevels vs the two council
 * paths inside runHeadlessCouncilAnalysis).
 *
 * @param {Object} db - Database instance
 * @param {Object} config - Application configuration
 * @param {Object} params
 * @param {number} params.reviewId - Review id comments are stored under
 * @param {string} params.worktreePath - Checked-out worktree / local repo path
 * @param {Object} params.prMetadata - PR/local metadata (head_sha, base_sha, etc.)
 * @param {Array|null} params.changedFiles - Changed-file list (local mode) or null (PR mode computes it)
 * @param {string} params.repository - owner/repo
 * @param {Object|null} params.repoSettings - Repo settings row
 * @param {Object} params.instructions - { globalInstructions, repoInstructions, requestInstructions }
 * @param {Object} params.reviewConfig - Result of resolveReviewConfig (single|council)
 * @param {Object} params.providerOverrides - Single-provider overrides (e.g. { load_skills })
 * @param {Object} [params.githubClient] - GitHub client (PR mode) or undefined (local)
 * @returns {Promise<{ runId: string, result: Object }>}
 */
async function runHeadlessAnalysis(db, config, {
  reviewId,
  worktreePath,
  prMetadata,
  changedFiles,
  repository,
  repoSettings,
  instructions,
  reviewConfig,
  providerOverrides,
  githubClient
}) {
  if (reviewConfig.type === 'council') {
    console.log(`Running council analysis: ${reviewConfig.council.name} (${reviewConfig.configType})...`);
    // Council voices can span multiple providers, so resolve a per-provider
    // load_skills map (tier-3 resolution per provider) the same way every other
    // council invoker does (pr.js / local.js / stack-analysis.js). Passing only
    // the shared providerOverrides would collapse every voice onto the default
    // provider's load_skills — see buildVoiceContext.
    const { providerOverrides: councilProviderOverrides, providerOverridesMap: councilProviderOverridesMap } =
      buildCouncilProviderOverrides(config, repository, repoSettings);
    const analyzer = new Analyzer(db, 'council', 'council', councilProviderOverrides, councilProviderOverridesMap);
    const result = await runHeadlessCouncilAnalysis(db, {
      analyzer,
      reviewId,
      council: reviewConfig.council,
      configType: reviewConfig.configType,
      councilConfig: reviewConfig.councilConfig,
      worktreePath,
      prMetadata,
      changedFiles,
      instructions,
      githubClient
    });
    return { runId: result.runId, result };
  }

  console.log('Running AI analysis (all 3 levels)...');
  const runId = uuidv4();
  const analyzer = new Analyzer(db, reviewConfig.model, reviewConfig.provider, providerOverrides);
  const result = await analyzer.analyzeAllLevels(
    reviewId,
    worktreePath,
    prMetadata,
    null,
    instructions,
    changedFiles,
    { githubClient, runId }
  );
  return { runId, result };
}

/**
 * Prepare a PR for headless analysis-only mode (no GitHub submit).
 *
 * This is the analysis-only twin of the prep block inside `performHeadlessReview`.
 * It is intentionally a STANDALONE function rather than an extraction from
 * `performHeadlessReview`: the latter's prep and submit blocks share many locals
 * and that function is CI-critical, so duplicating the minimal prep here (the
 * documented fallback in the plan) keeps the submit path byte-identical and
 * untouched. The prep mirrors `performHeadlessReview` (parse → token/binding →
 * client → fetch PR → worktree/pool acquire → diff → storePRData → metadata →
 * review → repoSettings → reviewConfig), minus anything only the submit path
 * needs.
 *
 * @param {Object} db - Database instance
 * @param {Object} config - Application configuration
 * @param {Object} flags - Parsed CLI flags
 * @param {Array<string>} prArgs - PR identifier args
 * @param {import('./git/worktree-pool-lifecycle').WorktreePoolLifecycle} [externalPoolLifecycle]
 *   - The session's already-rehydrated pool lifecycle. Reused for pool
 *   acquisition (mirrors `performHeadlessReview`'s `externalPoolLifecycle`
 *   convention) so the in-memory usage tracker populated by
 *   `resetAndRehydrate()` is the one acquisitions go through. Falls back to a
 *   fresh instance only when not supplied.
 * @returns {Promise<Object>} { githubClient, worktreePath, storedPRData, review,
 *   repository, repoSettings, poolWorktreeId, poolLifecycle, reviewConfig,
 *   providerOverrides }
 */
async function preparePrHeadless(db, config, flags, prArgs, externalPoolLifecycle = null) {
  const parser = new PRArgumentParser(config);
  const prInfo = await parser.parsePRArguments(prArgs);

  // Fail-fast council validation (mirrors performHeadlessReview).
  if (flags.council) {
    const council = await resolveCouncilHandle(db, flags.council);
    const configType = council.type || 'advanced';
    const councilConfig = normalizeCouncilConfig(council.config, configType);
    const validationError = validateCouncilConfig(councilConfig, configType);
    if (validationError) {
      throw new Error(`Invalid council "${council.name}": ${validationError}`);
    }
  }

  const repositoryForBinding = prInfo.bindingRepository
    || normalizeRepository(prInfo.owner, prInfo.repo);
  // Preflight the token so a missing credential fails fast before any network
  // work. Tolerates a dual repo with only an alt token when the host is unknown
  // (the setup probe tries the alt host first).
  const preflightBinding = resolvePreflightBinding(repositoryForBinding, config, prInfo.host);
  if (!preflightBinding.token) {
    throw new Error(buildMissingTokenError({
      owner: prInfo.owner,
      repo: prInfo.repo,
      bindingRepository: repositoryForBinding,
      apiHost: preflightBinding.apiHost
    }));
  }

  console.log(`Processing pull request #${prInfo.number} from ${prInfo.owner}/${prInfo.repo} in headless mode`);

  // Resolve the per-PR host binding and fetch (host precedence: URL-paste host
  // → stored host → ambiguity/probe for dual repos).
  console.log('Fetching pull request data from GitHub...');
  const { binding: headlessBinding, prData, githubClient } = await resolvePrHostBinding({
    db, config, bindingRepository: repositoryForBinding,
    owner: prInfo.owner, repo: prInfo.repo, prNumber: prInfo.number,
    // Only forward a github.com token as the github fallback (see performHeadlessReview).
    host: prInfo.host, githubToken: preflightBinding.apiHost === null ? preflightBinding.token : ''
  });

  let worktreePath;
  let diff;
  let changedFiles;
  let poolWorktreeId = null;
  let poolLifecycle = null;
  const repository = normalizeRepository(prInfo.owner, prInfo.repo);

  // Everything from here on can acquire a pool worktree and then do work that
  // may throw (diff generation, storePRData, metadata query, resolveReviewConfig).
  // The caller (handleHeadlessAnalysis) releases the pool slot in a finally, but
  // ONLY once it holds the returned prep object — a throw before that return would
  // leak the acquired worktree. So on the throwing path we release it here before
  // re-throwing. `poolWorktreeId` is null until acquire succeeds, so the guarded
  // release is a no-op when the throw predates acquisition (no double-release: the
  // caller's finally runs only on the success path that returns below).
  try {
  if (flags.useCheckout) {
    worktreePath = process.cwd();
    const isMatchingRepo = await parser.isMatchingRepository(worktreePath, prInfo.owner, prInfo.repo);
    if (!isMatchingRepo) {
      throw new Error(
        `--use-checkout requires running from a checkout of ${prInfo.owner}/${prInfo.repo}, ` +
        `but current directory does not match. Either cd to the correct repository or remove --use-checkout.`
      );
    }
    await registerRepositoryLocation(db, worktreePath, prInfo.owner, prInfo.repo);
    console.log(`Using current checkout at ${worktreePath}`);

    console.log('Generating unified diff from checkout...');
    const git = simpleGit(worktreePath);
    try {
      await fetchNoTags(git, ['origin', prData.base_sha]);
    } catch (fetchError) {
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
      repositoryPath = currentDir;
      await registerRepositoryLocation(db, currentDir, prInfo.owner, prInfo.repo);
      const repoSettingsRepo = new RepoSettingsRepository(db);
      const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
      const resolved = resolveRepoOptions(config, repositoryForBinding, repoSettings);
      checkoutScript = resolved.checkoutScript;
      checkoutTimeout = resolved.checkoutTimeout;
      worktreeConfig = resolved.worktreeConfig;
      poolSize = resolved.poolSize || 0;
      resetScript = resolved.resetScript || null;
    } else {
      console.log(`Current directory is not a checkout of ${prInfo.owner}/${prInfo.repo}, locating repository...`);
      const result = await findRepositoryPath({
        db,
        owner: prInfo.owner,
        repo: prInfo.repo,
        repository,
        bindingRepository: repositoryForBinding,
        prNumber: prInfo.number,
        config,
        cloneUrl: prData?.repository?.clone_url,
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
      const repoSettingsRepo = new RepoSettingsRepository(db);
      const repoSettings = await repoSettingsRepo.getRepoSettings(repository);
      const { poolSize: resolvedPoolSize } = resolvePoolConfig(config, repositoryForBinding, repoSettings);
      poolSize = resolvedPoolSize || 0;
      resetScript = config ? getRepoResetScript(config, repositoryForBinding) : null;
    }

    const worktreeManager = new GitWorktreeManager(db, worktreeConfig || {});
    if (poolSize > 0) {
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

  console.log('Storing pull request data...');
  const { isNewReview, reviewId: storedReviewId } = await storePRData(db, prInfo, prData, diff, changedFiles, worktreePath, {
    skipWorktreeRecord: !!flags.useCheckout,
    host: headlessBinding.host
  });

  if (poolWorktreeId && poolLifecycle) {
    await poolLifecycle.setReviewOwner(poolWorktreeId, storedReviewId);
  }

  if (isNewReview) {
    fireReviewStartedHook({
      reviewId: storedReviewId, prNumber: prInfo.number,
      owner: prInfo.owner, repo: prInfo.repo, prData, config,
    }).catch(err => { logger.warn(`Review hook failed: ${err.message}`); });
  }

  const prMetadata = await queryOne(db, `
    SELECT id, pr_data FROM pr_metadata
    WHERE pr_number = ? AND repository = ? COLLATE NOCASE
  `, [prInfo.number, repository]);

  if (!prMetadata) {
    throw new Error('Failed to retrieve stored PR metadata');
  }

  const storedPRData = JSON.parse(prMetadata.pr_data);

  const reviewRepo = new ReviewRepository(db);
  const { review } = await reviewRepo.getOrCreate({ prNumber: prInfo.number, repository });

  const repoSettingsRepo = new RepoSettingsRepository(db);
  const repoSettings = await repoSettingsRepo.getRepoSettings(repository);

  const reviewConfig = await resolveReviewConfig(
    db,
    repository,
    { council: flags.council, model: flags.model },
    config
  );

  const cliProvider = reviewConfig.type === 'single' ? reviewConfig.provider : null;
  const providerLoadSkills = cliProvider ? config.providers?.[cliProvider]?.load_skills : undefined;
  const loadSkills = resolveLoadSkills(config, repository, repoSettings, providerLoadSkills);
  const providerOverrides = { load_skills: loadSkills };

  return {
    githubClient,
    worktreePath,
    storedPRData,
    review,
    repository,
    repoSettings,
    poolWorktreeId,
    poolLifecycle,
    reviewConfig,
    providerOverrides
  };
  } catch (prepErr) {
    // Release the acquired pool worktree (if any) before propagating — the
    // caller never received a prep object, so its finally won't run. Guarded on
    // poolWorktreeId so a throw before acquisition is a no-op. Release errors are
    // logged, not allowed to mask the original failure.
    if (poolWorktreeId && poolLifecycle) {
      try {
        await poolLifecycle.releaseAfterHeadless(poolWorktreeId);
        logger.info(`Released pool worktree ${poolWorktreeId} after headless prep failure`);
      } catch (releaseErr) {
        logger.error(`Failed to release pool worktree ${poolWorktreeId} after prep failure: ${releaseErr.message}`);
      }
    }
    throw prepErr;
  }
}

/**
 * Record a completed, zero-suggestion analysis run for an empty-scope headless
 * local review (the analyzer is never invoked). Mirrors the web routes'
 * empty-scope guard but, lacking an HTTP response, persists a normal-shaped run
 * so `buildHeadlessJson` emits the standard `{ run, suggestions: [], count: 0 }`
 * envelope and the command still exits 0 ("zero suggestions is still success").
 * The run is attributed to whatever `reviewConfig` resolved (single or council).
 *
 * @param {Object} db - Database instance
 * @param {Object} params
 * @param {number} params.reviewId - Review id the run belongs to
 * @param {Object} params.reviewConfig - resolveReviewConfig result (single|council)
 * @param {Object} params.instructions - { globalInstructions, repoInstructions, requestInstructions }
 * @param {string|null} params.headSha - Head SHA recorded on the run
 * @returns {Promise<string>} The created run id
 */
async function recordEmptyScopeRun(db, { reviewId, reviewConfig, instructions, headSha }) {
  const runId = uuidv4();
  const runRepo = new AnalysisRunRepository(db);
  const isCouncil = reviewConfig.type === 'council';
  await runRepo.create({
    id: runId,
    reviewId,
    provider: isCouncil ? 'council' : reviewConfig.provider,
    model: isCouncil ? reviewConfig.council.id : reviewConfig.model,
    tier: null,
    globalInstructions: instructions?.globalInstructions || null,
    repoInstructions: instructions?.repoInstructions || null,
    requestInstructions: instructions?.requestInstructions || null,
    headSha: headSha || null,
    configType: isCouncil ? reviewConfig.configType : 'single',
    levelsConfig: null
  });
  await runRepo.update(runId, {
    status: 'completed',
    summary: 'No changes found in the selected scope — analysis skipped.',
    totalSuggestions: 0,
    filesAnalyzed: 0
  });
  return runId;
}

/**
 * Headless analysis-only handler: run analysis (single or council), store it in
 * the DB, report the consolidated run to stdout/stderr, and exit. No server, no
 * browser, no GitHub post. Works with a PR arg or --local.
 *
 * @param {Array<string>} prArgs - PR identifier args (empty for --local)
 * @param {Object} config - Application configuration
 * @param {Object} db - Database instance
 * @param {Object} flags - Parsed CLI flags
 * @param {import('./git/worktree-pool-lifecycle').WorktreePoolLifecycle} poolLifecycle
 *   - The session's rehydrated pool lifecycle. Forwarded to `preparePrHeadless`
 *   for PR-mode pool acquisition so the rehydrated in-memory tracker is used;
 *   local mode has no worktree/pool and ignores it.
 */
async function handleHeadlessAnalysis(prArgs, config, db, flags, poolLifecycle) {
  // NOTE: In --json mode, redirectConsoleToStderr() is already called in main()
  // BEFORE the DB-init/migration/pool-rehydrate block, so stdout is clean by the
  // time we get here (those earlier steps log to stdout and would otherwise
  // precede and corrupt the JSON document). No redirect is needed in this
  // handler — it would be too late and is redundant.

  // Resolve per-run custom instructions; a bad --instructions-file path fails
  // fast with a clear operational error (propagates to main()'s catch → exit 1).
  const requestInstructions = await resolveCliInstructions(flags);

  const globalInstructions = config.globalInstructions || null;

  let runId;
  let mode;

  if (flags.local) {
    mode = 'local';

    // Fail-fast council validation (mirror the PR path; local mode otherwise
    // lacks an explicit pre-flight check here).
    if (flags.council) {
      const council = await resolveCouncilHandle(db, flags.council);
      const configType = council.type || 'advanced';
      const councilConfig = normalizeCouncilConfig(council.config, configType);
      const validationError = validateCouncilConfig(councilConfig, configType);
      if (validationError) {
        throw new Error(`Invalid council "${council.name}": ${validationError}`);
      }
    }

    const resolvedPath = require('path').resolve(flags.localPath || process.cwd());
    console.log(`Finding git repository root from ${resolvedPath}...`);
    const repoPath = await findGitRoot(resolvedPath);
    console.log(`Found git repository at: ${repoPath}`);

    // Headless is a one-shot run: suppress the interactive summary/tour jobs so
    // they don't spend provider budget after the result is reported or keep the
    // event loop alive (CLI hang). See setupLocalReviewSession.
    const session = await setupLocalReviewSession({ db, config, repoPath, flags, startBackgroundJobs: false });

    const repository = session.repository;
    const repoSettings = await new RepoSettingsRepository(db).getRepoSettings(repository);
    const repoInstructions = repoSettings?.default_instructions || null;

    // Build local analysis metadata (mirror src/routes/local.js).
    const hasBranch = includesBranch(session.scopeStart);
    let analysisBaseSha = session.headSha;
    if (hasBranch && session.baseBranch) {
      try {
        analysisBaseSha = await findMergeBase(repoPath, session.baseBranch);
      } catch {
        // Fall back to HEAD
      }
    }
    const localMetadata = {
      id: session.sessionId,
      repository,
      title: hasBranch
        ? `Branch changes: ${session.baseBranch}..HEAD`
        : `Local changes in ${repository}`,
      description: hasBranch
        ? `Reviewing committed changes on branch against ${session.baseBranch}`
        : `Reviewing uncommitted changes in ${repoPath}`,
      base_sha: analysisBaseSha,
      head_sha: session.headSha,
      // Scope context the analyzer's executable-provider path consults FIRST when
      // rebuilding the local diff (src/ai/analyzer.js → generateDiffForExecutable /
      // getChangedFiles check scopeStart/scopeEnd before base_sha/head_sha). Without
      // these, unstaged-/untracked-only and mixed scopes (where base_sha === head_sha
      // === HEAD) fall through to the SHA branch and produce an empty/partial diff.
      // Matches the interactive local council metadata (src/routes/local.js).
      base_branch: session.baseBranch || null,
      head_branch: session.branch || null,
      scopeStart: session.scopeStart,
      scopeEnd: session.scopeEnd,
      reviewType: 'local'
    };

    const reviewConfig = await resolveReviewConfig(
      db,
      repository,
      { council: flags.council, model: flags.model },
      config
    );
    const cliProvider = reviewConfig.type === 'single' ? reviewConfig.provider : null;
    const providerLoadSkills = cliProvider ? config.providers?.[cliProvider]?.load_skills : undefined;
    const loadSkills = resolveLoadSkills(config, repository, repoSettings, providerLoadSkills);
    const providerOverrides = { load_skills: loadSkills };

    const instructions = { globalInstructions, repoInstructions, requestInstructions };

    // Empty-scope detection is driven by the SESSION DIFF, not a second
    // changed-file enumeration. setupLocalReviewSession already generated the
    // scoped diff via generateScopedDiff, which THROWS on a hard git failure and
    // returns '' only when the scope is genuinely empty — so an empty diff is
    // authoritative, while an operational git error has already aborted the run.
    // (getChangedFiles, by contrast, swallows git errors and returns [], which
    // would let a failure masquerade as "no changes" and exit 0.)
    const isEmptyScope = !session.diff || session.diff.trim().length === 0;

    if (isEmptyScope) {
      // Empty-scope guard, mirroring the web routes' rejectIfEmptyScope (which
      // returns 409). Headless has no HTTP response, so instead emit a normal-
      // shaped, completed run with zero suggestions: emitHeadlessResult then
      // produces the standard { mode, run, suggestions: [], count: 0 } envelope
      // and exits 0 (zero suggestions is still success). Skipping the analyzer
      // avoids spending provider tokens on a guaranteed-empty result.
      runId = await recordEmptyScopeRun(db, {
        reviewId: session.sessionId,
        reviewConfig,
        instructions,
        headSha: session.headSha
      });
    } else {
      // Scope is non-empty (diff present), so the analyzer needs the scope-aware
      // changed-file list for suggestion validation. Use the throwing variant:
      // since we KNOW the scope is non-empty, a [] from a swallowed git error
      // would be a lie — surface it as a non-zero exit instead.
      const changedFiles = await getChangedFiles(repoPath, {
        scopeStart: session.scopeStart,
        scopeEnd: session.scopeEnd,
        baseBranch: session.baseBranch || null,
      }, { throwOnError: true });

      ({ runId } = await runHeadlessAnalysis(db, config, {
        reviewId: session.sessionId,
        worktreePath: repoPath,
        prMetadata: localMetadata,
        changedFiles,
        repository,
        repoSettings,
        instructions,
        reviewConfig,
        providerOverrides,
        githubClient: undefined
      }));
    }
  } else {
    mode = 'pr';
    // Forward the session's rehydrated pool lifecycle so pool acquisition goes
    // through the instance whose in-memory tracker resetAndRehydrate() populated
    // (mirrors performHeadlessReview's externalPoolLifecycle convention).
    const prep = await preparePrHeadless(db, config, flags, prArgs, poolLifecycle);
    try {
      const repoInstructions = prep.repoSettings?.default_instructions || null;
      const instructions = { globalInstructions, repoInstructions, requestInstructions };
      ({ runId } = await runHeadlessAnalysis(db, config, {
        reviewId: prep.review.id,
        worktreePath: prep.worktreePath,
        prMetadata: prep.storedPRData,
        changedFiles: null,
        repository: prep.repository,
        repoSettings: prep.repoSettings,
        instructions,
        reviewConfig: prep.reviewConfig,
        providerOverrides: prep.providerOverrides,
        githubClient: prep.githubClient
      }));
    } finally {
      // Release the pool worktree (mirror performHeadlessReview's finally) so a
      // pool slot isn't leaked per headless run. Local mode has no pool.
      if (prep.poolWorktreeId && prep.poolLifecycle) {
        try {
          await prep.poolLifecycle.releaseAfterHeadless(prep.poolWorktreeId);
          logger.info(`Released pool worktree ${prep.poolWorktreeId} after headless analysis`);
        } catch (releaseErr) {
          logger.error(`Failed to release pool worktree ${prep.poolWorktreeId}: ${releaseErr.message}`);
        }
      }
    }
  }

  await emitHeadlessResult(db, { runId, mode, flags });
}

/**
 * Build the machine-readable JSON document for a completed headless run.
 *
 * Returns the run metadata (with `level_outcomes` / `levels_config` parsed) plus
 * the run's consolidated final suggestions (orchestrated layer; per-suggestion
 * `reasoning` parsed) and a count. Exported for unit testing.
 *
 * @param {Object} db - Database instance
 * @param {string} runId - Analysis run id
 * @param {'pr'|'local'} mode - Review mode (passthrough)
 * @returns {Promise<Object>} { ok, mode, run, suggestions, count }
 */
async function buildHeadlessJson(db, runId, mode) {
  const run = await new AnalysisRunRepository(db).getById(runId, { includeDiff: false });
  if (run) {
    run.level_outcomes = safeParseJson(run.level_outcomes);
    run.levels_config = safeParseJson(run.levels_config);
  }

  const rawSuggestions = await new CommentRepository(db).getFinalSuggestionsByRunId(runId);
  const suggestions = rawSuggestions.map(s => ({
    ...s,
    reasoning: safeParseJson(s.reasoning)
  }));

  return {
    // `ok` lets a machine consumer branch on success/failure with a single field;
    // see buildHeadlessErrorJson for the failure shape.
    ok: true,
    mode,
    run,
    suggestions,
    count: suggestions.length
  };
}

/**
 * Build the machine-readable JSON document for a FAILED headless run.
 *
 * Mirrors buildHeadlessJson's envelope so a --headless --json consumer parses one
 * stream and branches on `ok`: success → { ok: true, ... }, failure → this. The
 * process still exits non-zero, so exit-code-based consumers are unaffected.
 * Exported for unit testing.
 *
 * @param {Object} params
 * @param {'pr'|'local'} params.mode - Review mode (best-effort, derived from args)
 * @param {Error} params.error - The thrown error
 * @returns {Object} { ok: false, mode, error: { message } }
 */
function buildHeadlessErrorJson({ mode, error }) {
  return {
    ok: false,
    mode,
    error: {
      message: error && error.message ? error.message : String(error)
    }
  };
}

/**
 * Emit the result of a headless run.
 *
 * In --json mode, writes the buildHeadlessJson document to stdout (via
 * process.stdout.write, since console.log is remapped to stderr in JSON mode).
 * Otherwise prints a human-readable summary to stdout. A successful run with zero
 * suggestions is still success — operational errors propagate to main()'s catch.
 *
 * @param {Object} db - Database instance
 * @param {Object} params
 * @param {string} params.runId - Analysis run id
 * @param {'pr'|'local'} params.mode - Review mode
 * @param {Object} params.flags - Parsed CLI flags
 */
async function emitHeadlessResult(db, { runId, mode, flags }) {
  const doc = await buildHeadlessJson(db, runId, mode);

  if (flags.json) {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
    return;
  }

  const run = doc.run || {};
  const lines = [];
  lines.push('');
  lines.push('Headless analysis complete');
  lines.push(`  Run ID:      ${runId}`);
  lines.push(`  Mode:        ${mode}`);
  if (run.config_type === 'council' || run.provider === 'council') {
    lines.push(`  Council:     ${run.model || '(unknown)'}`);
  } else {
    lines.push(`  Provider:    ${run.provider || '(unknown)'}`);
    lines.push(`  Model:       ${run.model || '(unknown)'}`);
  }
  lines.push(`  Config type: ${run.config_type || 'standard'}`);
  lines.push(`  Status:      ${run.status || '(unknown)'}`);
  if (run.summary) {
    lines.push('');
    lines.push('Summary:');
    lines.push(run.summary);
  }
  lines.push('');
  lines.push(`Suggestions: ${doc.count}`);
  for (const s of doc.suggestions) {
    const line = s.line_end && s.line_end !== s.line_start
      ? `${s.line_start}-${s.line_end}`
      : `${s.line_start}`;
    const sev = s.severity ? `/${s.severity}` : '';
    lines.push(`  ${s.file}:${line} [${s.type || 'comment'}${sev}] ${s.title || ''}`.trimEnd());
  }
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
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

      // Collect repos that might have pool config from either source.
      // Normalize to lowercase to match the database's COLLATE NOCASE identity.
      const repoNames = new Set(Object.keys(config.repos || {}).map(r => r.toLowerCase()));
      const allRepoSettings = await query(db, 'SELECT repository, pool_size, pool_fetch_interval_minutes FROM repo_settings WHERE pool_size IS NOT NULL OR pool_fetch_interval_minutes IS NOT NULL');
      for (const row of allRepoSettings) {
        repoNames.add(row.repository.toLowerCase());
      }

      if (repoNames.size === 0) return;

      for (const repoName of repoNames) {
        const repoSettings = allRepoSettings.find(r => r.repository.toLowerCase() === repoName.toLowerCase()) || null;
        const { poolSize, poolFetchIntervalMinutes } = resolvePoolConfig(config, repoName, repoSettings);
        if (!poolSize || !poolFetchIntervalMinutes) continue;

        const intervalMs = poolFetchIntervalMinutes * 60 * 1000;
        const worktrees = await poolRepo.findAllForFetch(repoName);

        // Check if any worktree actually needs fetching before claiming the lease
        const needsFetch = worktrees.some(entry => {
          if (!entry.last_fetched_at) return true;
          const elapsed = Date.now() - new Date(entry.last_fetched_at).getTime();
          return elapsed >= intervalMs;
        });
        if (!needsFetch) continue;

        // Atomically claim the fetch lease — skips if another instance holds it.
        // Pool worktrees share a git object store so concurrent fetches conflict.
        if (!(await repoSettingsRepo.tryClaimFetch(repoName))) {
          logger.info(`Background fetch skipped for ${repoName}: another instance is fetching`);
          continue;
        }
        try {
          for (const entry of worktrees) {
            // Skip if fetched recently (within the configured interval)
            if (entry.last_fetched_at) {
              const elapsed = Date.now() - new Date(entry.last_fetched_at).getTime();
              if (elapsed < intervalMs) continue;
            }

            if (!fs.existsSync(entry.path)) {
              logger.warn(`Background fetch skipped for ${entry.id}: directory no longer exists (${entry.path})`);
              continue;
            }

            logger.info(`Background fetch starting for ${repoName} pool worktree ${entry.id}`);
            try {
              const git = simpleGit(entry.path, { timeout: { block: 300000 } });
              const remotes = await git.getRemotes();
              const remote = remotes.find(r => r.name === 'origin') || remotes[0];
              if (remote) await fetchNoTags(git, ['--prune', remote.name]);
              await poolRepo.updateLastFetched(entry.id);
              // Refresh the lease so the stale guard only needs to outlive
              // a single stalled fetch, not the entire serial loop.
              await repoSettingsRepo.refreshFetchLease(repoName);
              logger.info(`Background fetch complete for ${repoName} pool worktree ${entry.id}`);
            } catch (fetchErr) {
              logger.warn(`Background fetch failed for ${entry.id}: ${fetchErr.message}`);
            }
          }
        } finally {
          try {
            await repoSettingsRepo.markFetchFinished(repoName);
          } catch (finishErr) {
            logger.warn(`Failed to release fetch lease for ${repoName}: ${finishErr.message}`);
          }
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

// Handle uncaught exceptions.
//
// Note: in --headless --json mode, errors that ESCAPE main()'s try (floating
// promises, timer/child-process callbacks) reach here and are reported as prose
// on stderr, not the JSON failure envelope. The headless flow awaits its full
// analysis, so this is a narrow gap; a JSON envelope here would need an
// emit-once guard to avoid a second document on stdout during post-success
// teardown.
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

module.exports = { main, parseArgs, detectPRFromGitHubEnvironment, printCouncilList, runHeadlessAnalysis, recordEmptyScopeRun, buildHeadlessJson, buildHeadlessErrorJson, resolveCliInstructions };
