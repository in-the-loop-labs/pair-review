// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const logger = require('./utils/logger');

let _cachedCommandToken = null;

const CONFIG_DIR = path.join(os.homedir(), '.pair-review');
const DEFAULT_CHECKOUT_TIMEOUT_MS = 300000;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CONFIG_LOCAL_FILE = path.join(CONFIG_DIR, 'config.local.json');
const CONFIG_EXAMPLE_FILE = path.join(CONFIG_DIR, 'config.example.json');
const PACKAGE_ROOT = path.join(__dirname, '..');
const MANAGED_CONFIG_FILE = path.join(PACKAGE_ROOT, 'config.managed.json');

const DEFAULT_CONFIG = {
  github_token: "",
  github_token_command: "gh auth token",  // Shell command whose stdout is used as the GitHub token
  port: 7247,
  theme: "light",
  default_provider: "claude",  // AI provider: 'claude', 'gemini', 'codex', 'copilot', 'opencode', 'cursor-agent', 'pi'
  default_model: "opus",       // Model within the provider (e.g., 'opus' for Claude, 'gemini-2.5-pro' for Gemini)
  worktree_retention_days: 7,
  review_retention_days: 21,
  dev_mode: false,  // When true, disables static file caching for development
  debug_stream: false,  // When true, logs AI provider streaming events (equivalent to --debug-stream CLI flag)
  db_name: "",  // Custom database filename (default: database.db). Useful for per-worktree isolation.
  yolo: false,  // When true, skips fine-grained AI provider permission setup (equivalent to --yolo CLI flag)
  enable_chat: true,  // When true, enables the chat panel feature (uses chat_provider)
  chat_provider: "pi",  // Chat provider: 'pi', 'copilot-acp', 'gemini-acp', 'opencode-acp', 'cursor-acp', 'codex'
  comment_format: "legacy",  // Comment format preset or custom template for adopted suggestions
  chat: { enable_shortcuts: true, enter_to_send: true },  // Chat panel settings (enable_shortcuts: show action shortcut buttons, enter_to_send: Enter sends message instead of newline)
  providers: {},  // Custom AI analysis provider configurations (overrides built-in defaults)
  chat_providers: {},  // Custom chat provider configurations (overrides built-in defaults)
  repos: {},  // Repository configurations: { "owner/repo": { path: "~/path/to/clone" } }
  assisted_by_url: "https://github.com/in-the-loop-labs/pair-review",  // URL for "Review assisted by" footer link
  hooks: {},  // Hook commands per event: { "review.started": { "my_hook": { "command": "..." } } }
  enable_graphite: false,  // When true, shows Graphite links alongside GitHub links
  skip_update_notifier: false  // When true, suppresses the "update available" notification on exit
};

/**
 * Validates port number
 * @param {number} port - Port number to validate
 * @returns {boolean} - True if valid
 */
function validatePort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * Recursively merges source into target for plain objects.
 * Arrays and scalars in source replace the corresponding value in target.
 * Null in source overwrites target. Returns a new object; inputs are not mutated.
 * @param {Object} target - Base object
 * @param {Object} source - Object to merge on top
 * @returns {Object} - Merged result
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return { ...source };

  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Gets a config value with fallback to legacy key names
 * Supports backwards compatibility without modifying the config file
 * @param {Object} config - Configuration object
 * @param {string} key - New key name
 * @param {string} legacyKey - Old key name (fallback)
 * @returns {*} - Value from new key, or legacy key if new key not present
 */
function getConfigValue(config, key, legacyKey) {
  if (key in config) {
    return config[key];
  }
  if (legacyKey && legacyKey in config) {
    logger.debug(`Using legacy config key "${legacyKey}" for "${key}"`);
    return config[legacyKey];
  }
  return undefined;
}

/**
 * Gets the default provider from config with legacy fallback
 * Checks 'default_provider' first, falls back to 'provider'
 * @param {Object} config - Configuration object
 * @returns {string} - Provider name
 */
function getDefaultProvider(config) {
  return getConfigValue(config, 'default_provider', 'provider') || DEFAULT_CONFIG.default_provider;
}

/**
 * Gets the default model from config with legacy fallback
 * Checks 'default_model' first, falls back to 'model'
 * @param {Object} config - Configuration object
 * @returns {string} - Model name
 */
function getDefaultModel(config) {
  return getConfigValue(config, 'default_model', 'model') || DEFAULT_CONFIG.default_model;
}

/**
 * Copies the example config file to the user's config directory
 * @returns {Promise<boolean>} True if copied successfully, false if source doesn't exist
 */
async function copyExampleConfig() {
  const sourceExample = path.join(PACKAGE_ROOT, 'config.example.json');
  try {
    await fs.access(sourceExample);
    await fs.copyFile(sourceExample, CONFIG_EXAMPLE_FILE);
    console.log(`Copied config.example.json to: ${CONFIG_EXAMPLE_FILE}`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Source example file doesn't exist (shouldn't happen in normal install)
      logger.debug('config.example.json not found in package, skipping copy');
      return false;
    }
    // Log but don't fail for other errors
    logger.debug(`Failed to copy config.example.json: ${error.message}`);
    return false;
  }
}

/**
 * Ensures the config directory exists
 * @returns {Promise<boolean>} True if directory was newly created
 */
async function ensureConfigDir() {
  try {
    await fs.access(CONFIG_DIR);
    return false; // Directory already existed
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        console.log(`Created config directory: ${CONFIG_DIR}`);
        // Copy example config to new directory
        await copyExampleConfig();
        return true; // Directory was newly created
      } catch (mkdirError) {
        if (mkdirError.code === 'EACCES' || mkdirError.code === 'EPERM') {
          console.error(`Cannot create configuration directory at ~/.pair-review/`);
          process.exit(1);
        }
        throw mkdirError;
      }
    } else {
      throw error;
    }
  }
}

/**
 * Loads configuration from file or creates default
 * @returns {Promise<{config: Object, isFirstRun: boolean}>} Config and first-run flag
 */
async function loadConfig() {
  await ensureConfigDir();

  const localDir = path.join(process.cwd(), '.pair-review');
  const sources = [
    { path: MANAGED_CONFIG_FILE,                         label: 'managed config',       required: false },
    { path: CONFIG_FILE,                                label: 'global config',        required: true  },
    { path: CONFIG_LOCAL_FILE,                           label: 'global local config',  required: false },
    { path: path.join(localDir, 'config.json'),         label: 'project config',       required: false },
    { path: path.join(localDir, 'config.local.json'),   label: 'project local config', required: false },
  ];

  let mergedConfig = { ...DEFAULT_CONFIG };
  let isFirstRun = false;
  let hasManagedConfig = false;

  for (const source of sources) {
    try {
      const data = await fs.readFile(source.path, 'utf8');
      const parsed = JSON.parse(data);
      if (source.label === 'managed config' && Object.keys(parsed).length > 0) {
        hasManagedConfig = true;
      }
      mergedConfig = deepMerge(mergedConfig, parsed);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (source.required && !hasManagedConfig) {
          // Global config doesn't exist — create it with defaults
          const config = { ...DEFAULT_CONFIG };
          await saveConfig(config);
          logger.debug(`Created default config file: ${CONFIG_FILE}`);
          isFirstRun = true;
        }
        // Optional files or managed-config-present: skip silently
      } else if (error instanceof SyntaxError) {
        if (source.required) {
          console.error(`Invalid configuration file at ~/.pair-review/config.json`);
          process.exit(1);
        }
        logger.warn(`Malformed config at ${source.label}, skipping`);
      } else {
        throw error;
      }
    }
  }

  // Normalize legacy monorepos key into repos (monorepos values are overridden by repos)
  if (mergedConfig.monorepos) {
    mergedConfig.repos = deepMerge(mergedConfig.monorepos, mergedConfig.repos);
  }

  // Validate port
  if (!validatePort(mergedConfig.port)) {
    console.error(`Invalid port number ${mergedConfig.port}`);
    process.exit(1);
  }

  // Load global instructions from ~/.pair-review/global-instructions.md
  const globalInstructionsPath = path.join(CONFIG_DIR, 'global-instructions.md');
  try {
    const content = await fs.readFile(globalInstructionsPath, 'utf-8');
    const trimmed = content.trim();
    if (trimmed) {
      mergedConfig.globalInstructions = trimmed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Could not read global instructions from ${globalInstructionsPath}: ${error.message}`);
    }
  }

  return { config: mergedConfig, isFirstRun };
}

/**
 * Saves configuration to file
 * @param {Object} config - Configuration object to save
 */
async function saveConfig(config) {
  await ensureConfigDir();
  
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      console.error(`Cannot create configuration directory at ~/.pair-review/`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Gets the configuration directory path
 * @returns {string} - Config directory path
 */
function getConfigDir() {
  return CONFIG_DIR;
}

/**
 * Gets the GitHub token with environment variable taking precedence over config file.
 * Priority:
 *   1. GITHUB_TOKEN environment variable (highest priority)
 *   2. config.github_token from ~/.pair-review/config.json
 *   3. config.github_token_command — execute shell command, use stdout (cached on success)
 *   4. Empty string (no token)
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string} - GitHub token or empty string if not configured
 */
function getGitHubToken(config) {
  if (process.env.GITHUB_TOKEN) {
    logger.debug('Using GitHub token from GITHUB_TOKEN environment variable');
    return process.env.GITHUB_TOKEN;
  }
  if (config.github_token) {
    logger.debug('Using GitHub token from config.github_token');
    return config.github_token;
  }
  if (config.github_token_command) {
    if (_cachedCommandToken !== null) {
      logger.debug('Using GitHub token from github_token_command (cached)');
      return _cachedCommandToken;
    }
    logger.debug(`Attempting GitHub token from command: ${config.github_token_command}`);
    try {
      const result = childProcess.execSync(config.github_token_command, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      if (!result) {
        logger.warn(`github_token_command did not produce a token (command: ${config.github_token_command})`);
        return '';
      }
      logger.debug('Using GitHub token from github_token_command');
      _cachedCommandToken = result;
      return result;
    } catch (error) {
      logger.warn(`github_token_command failed (command: ${config.github_token_command}): ${error.message}`);
      return '';
    }
  }
  logger.debug('No GitHub token configured');
  return '';
}

/**
 * Resets the cached command token. Exported for testing only.
 */
function _resetTokenCache() {
  _cachedCommandToken = null;
}

/**
 * Detect if running via npx vs a global npm install.
 * When running via npx, npm_execpath typically points to npm-cli.js or npx
 * @returns {boolean} True if running via npx
 */
function isRunningViaNpx() {
  const execPath = process.env.npm_execpath || '';
  const npmCommand = process.env.npm_command || '';
  // npx sets npm_command to 'exec' and npm_execpath to npm-cli.js
  // A global install would typically not have these set, or npm_command would be 'run'
  return npmCommand === 'exec' || execPath.includes('npx') || execPath.includes('npm-cli');
}

/**
 * Display the first-run welcome message.
 * Shows helpful getting started information on first run.
 */
function showWelcomeMessage() {
  const cmd = isRunningViaNpx() ? 'npx @in-the-loop-labs/pair-review' : 'pair-review';
  // Box width: 77 chars total (75 inner + 2 borders)
  // Inner content width: 75 chars
  // Command lines: 6 leading spaces + cmd + args + trailing padding + │
  const boxWidth = 75;
  const cmdIndent = 6;

  // Calculate padding for each command line (subtract content, leave space before │)
  const localPad = boxWidth - cmdIndent - cmd.length - ' --local'.length;
  const configPad = boxWidth - cmdIndent - cmd.length - ' --configure'.length;
  const helpPad = boxWidth - cmdIndent - cmd.length - ' --help'.length;

  console.log(`
┌───────────────────────────────────────────────────────────────────────────┐
│  Welcome to pair-review, your AI-assisted code review partner!            │
│                                                                           │
│  Try pair-review now to review local changes, no setup required:          │
│      ${cmd} --local${' '.repeat(Math.max(0, localPad))}│
│                                                                           │
│  To review PRs from GitHub and submit feedback, you'll need a token:      │
│      ${cmd} --configure${' '.repeat(Math.max(0, configPad))}│
│                                                                           │
│  See full usage help:                                                     │
│      ${cmd} --help${' '.repeat(Math.max(0, helpPad))}│
└───────────────────────────────────────────────────────────────────────────┘
`);
}

/**
 * Expands paths that start with ~/ to use the user's home directory.
 *
 * Note: Node.js does not have built-in tilde expansion. The os.homedir()
 * function returns the home directory path but doesn't expand tildes in
 * strings. This manual approach is the standard pattern; external packages
 * like 'expand-tilde' exist but add unnecessary dependencies for this
 * simple use case.
 *
 * @param {string} p - Path to expand
 * @returns {string} - Expanded path
 */
function expandPath(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Get repository configuration, checking `repos` key first, falling back to `monorepos`.
 * @param {object} config
 * @param {string} repository - owner/repo
 * @returns {object|null}
 */
function getRepoConfig(config, repository) {
  const reposSection = config.repos || {};
  const entry = reposSection[repository];
  if (entry) return entry;

  const legacySection = config.monorepos || {};
  return legacySection[repository] || null;
}

/**
 * Gets the configured repository path
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Expanded path or null if not configured
 */
function getRepoPath(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  if (repoConfig?.path) {
    return expandPath(repoConfig.path);
  }
  return null;
}

/**
 * Gets the configured checkout script for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Checkout script path or null if not configured
 */
function getRepoCheckoutScript(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.checkout_script || null;
}

/**
 * Gets the configured worktree directory for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Expanded worktree directory path or null if not configured
 */
function getRepoWorktreeDirectory(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  if (repoConfig?.worktree_directory) {
    return expandPath(repoConfig.worktree_directory);
  }
  return null;
}

/**
 * Gets the configured worktree name template for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Template string or null if not configured
 */
function getRepoWorktreeNameTemplate(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.worktree_name_template || null;
}

/**
 * Gets the configured checkout script timeout for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {number} - Timeout in milliseconds (default: 300000 = 5 minutes)
 */
function getRepoCheckoutTimeout(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  if (repoConfig?.checkout_timeout_seconds > 0) {
    return repoConfig.checkout_timeout_seconds * 1000;
  }
  return DEFAULT_CHECKOUT_TIMEOUT_MS; // 5 minutes default
}

/**
 * Gets the configured reset script for a repository
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {string|null} - Reset script path or null if not configured
 */
function getRepoResetScript(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  return repoConfig?.reset_script || null;
}

/**
 * Gets the configured pool size for a repository from file config only.
 * Prefer resolvePoolConfig() when DB repo_settings are available.
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {number} - Pool size (0 if not configured or invalid)
 */
function getRepoPoolSize(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const size = repoConfig?.pool_size;
  return (typeof size === 'number' && size > 0) ? size : 0;
}

/**
 * Gets the configured pool fetch interval for a repository from file config only.
 * Prefer resolvePoolConfig() when DB repo_settings are available.
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @returns {number|null} - Interval in minutes or null if not configured
 */
function getRepoPoolFetchInterval(config, repository) {
  const repoConfig = getRepoConfig(config, repository);
  const minutes = repoConfig?.pool_fetch_interval_minutes;
  return (typeof minutes === 'number' && minutes > 0) ? minutes : null;
}

/**
 * Resolves pool configuration for a repository, checking DB repo_settings first,
 * then falling back to file config. DB values take precedence when set (non-null).
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @param {Object|null} repoSettings - DB repo_settings row (from RepoSettingsRepository.getRepoSettings)
 * @returns {{ poolSize: number, poolFetchIntervalMinutes: number|null }}
 */
function resolvePoolConfig(config, repository, repoSettings) {
  const dbPoolSize = repoSettings?.pool_size;
  const dbFetchInterval = repoSettings?.pool_fetch_interval_minutes;

  const poolSize = (typeof dbPoolSize === 'number' && dbPoolSize >= 0)
    ? dbPoolSize
    : getRepoPoolSize(config, repository);

  const poolFetchIntervalMinutes = (typeof dbFetchInterval === 'number' && dbFetchInterval >= 0)
    ? (dbFetchInterval > 0 ? dbFetchInterval : null)
    : getRepoPoolFetchInterval(config, repository);

  return { poolSize, poolFetchIntervalMinutes };
}

/**
 * Resolves all repository worktree options into a single object.
 * Composite helper that combines the individual getters into the shape expected
 * by GitWorktreeManager and createWorktreeForPR.
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @param {string} repository - Repository in "owner/repo" format
 * @param {Object|null} [repoSettings=null] - DB repo_settings row (from RepoSettingsRepository.getRepoSettings)
 * @returns {{ checkoutScript: string|null, checkoutTimeout: number, worktreeConfig: Object|null, resetScript: string|null, poolSize: number, poolFetchIntervalMinutes: number|null }}
 */
function resolveRepoOptions(config, repository, repoSettings = null) {
  const checkoutScript = getRepoCheckoutScript(config, repository);
  const checkoutTimeout = getRepoCheckoutTimeout(config, repository);
  const worktreeDirectory = getRepoWorktreeDirectory(config, repository);
  const nameTemplate = getRepoWorktreeNameTemplate(config, repository);

  let worktreeConfig = null;
  if (worktreeDirectory || nameTemplate) {
    worktreeConfig = {};
    if (worktreeDirectory) worktreeConfig.worktreeBaseDir = worktreeDirectory;
    if (nameTemplate) worktreeConfig.nameTemplate = nameTemplate;
  }

  const resetScript = getRepoResetScript(config, repository);
  const { poolSize, poolFetchIntervalMinutes } = resolvePoolConfig(config, repository, repoSettings);

  return { checkoutScript, checkoutTimeout, worktreeConfig, resetScript, poolSize, poolFetchIntervalMinutes };
}

/**
 * Resolves the database filename to use.
 * Priority:
 *   1. PAIR_REVIEW_DB_NAME environment variable (highest priority)
 *   2. config.db_name from config files
 *   3. 'database.db' (default)
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string} - Database filename
 */
function resolveDbName(config) {
  if (process.env.PAIR_REVIEW_DB_NAME) {
    return process.env.PAIR_REVIEW_DB_NAME;
  }
  return config.db_name || 'database.db';
}

/**
 * Warns if dev_mode is enabled but no custom db_name is configured.
 * Helps developers avoid accidentally corrupting the shared database
 * when switching between branches with different schemas.
 *
 * @param {Object} config - Configuration object from loadConfig()
 */
function warnIfDevModeWithoutDbName(config) {
  if (config.dev_mode && !config.db_name && !process.env.PAIR_REVIEW_DB_NAME) {
    logger.warn('dev_mode is enabled but no db_name is configured. Consider setting db_name in .pair-review/config.json or PAIR_REVIEW_DB_NAME env var to avoid schema conflicts between branches.');
  }
}

/**
 * Synchronously checks whether the update notifier should be skipped.
 * Reads config files in the standard merge order (managed → global → global.local
 * → project → project.local) and returns the resolved boolean value of
 * `skip_update_notifier`. Designed for use in bin/pair-review.js which runs
 * before the async main process.
 *
 * @returns {boolean} True if the update notifier should be suppressed
 */
function shouldSkipUpdateNotifier() {
  const fsSync = require('fs');
  const localDir = path.join(process.cwd(), '.pair-review');
  // Keep in sync with the sources list in loadConfig()
  const sources = [
    MANAGED_CONFIG_FILE,
    CONFIG_FILE,
    CONFIG_LOCAL_FILE,
    path.join(localDir, 'config.json'),
    path.join(localDir, 'config.local.json'),
  ];

  let skip = false;
  for (const filePath of sources) {
    try {
      const data = fsSync.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);
      if ('skip_update_notifier' in parsed) {
        skip = Boolean(parsed.skip_update_notifier);
      }
    } catch {
      // File missing or malformed — skip silently
    }
  }
  return skip;
}

module.exports = {
  deepMerge,
  loadConfig,
  getConfigDir,
  validatePort,
  getGitHubToken,
  getDefaultProvider,
  getDefaultModel,
  isRunningViaNpx,
  showWelcomeMessage,
  expandPath,
  // New repo-prefixed names
  getRepoConfig,
  getRepoPath,
  getRepoCheckoutScript,
  getRepoWorktreeDirectory,
  getRepoWorktreeNameTemplate,
  getRepoCheckoutTimeout,
  resolveRepoOptions,
  getRepoResetScript,
  getRepoPoolSize,
  getRepoPoolFetchInterval,
  resolvePoolConfig,
  resolveDbName,
  warnIfDevModeWithoutDbName,
  shouldSkipUpdateNotifier,
  _resetTokenCache,
  DEFAULT_CHECKOUT_TIMEOUT_MS
};