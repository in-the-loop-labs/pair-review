// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const logger = require('./utils/logger');

const CONFIG_DIR = path.join(os.homedir(), '.pair-review');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CONFIG_EXAMPLE_FILE = path.join(CONFIG_DIR, 'config.example.json');
const PACKAGE_ROOT = path.join(__dirname, '..');

const DEFAULT_CONFIG = {
  github_token: "",
  port: 3000,
  theme: "light",
  default_provider: "claude",  // AI provider: 'claude', 'gemini', 'codex', 'copilot', 'opencode'
  default_model: "sonnet",     // Model within the provider (e.g., 'sonnet' for Claude, 'gemini-2.5-pro' for Gemini)
  worktree_retention_days: 7,
  dev_mode: false,  // When true, disables static file caching for development
  providers: {}  // Custom provider configurations (overrides built-in defaults)
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

  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(configData);

    // Merge with defaults to ensure all keys exist
    // Legacy keys ('provider', 'model') are handled lazily via getDefaultProvider/getDefaultModel
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    // Validate port
    if (!validatePort(mergedConfig.port)) {
      console.error(`Invalid port number ${mergedConfig.port}`);
      process.exit(1);
    }

    return { config: mergedConfig, isFirstRun: false };
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Config file doesn't exist, create it with defaults
      const config = { ...DEFAULT_CONFIG };
      await saveConfig(config);
      logger.debug(`Created default config file: ${CONFIG_FILE}`);
      return { config, isFirstRun: true };
    } else if (error instanceof SyntaxError) {
      console.error(`Invalid configuration file at ~/.pair-review/config.json`);
      process.exit(1);
    } else {
      throw error;
    }
  }
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
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string} - GitHub token or empty string if not configured
 */
function getGitHubToken(config) {
  // Environment variable takes precedence
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  // Fall back to config file
  return config.github_token || '';
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

module.exports = {
  loadConfig,
  saveConfig,
  getConfigDir,
  validatePort,
  getGitHubToken,
  getDefaultProvider,
  getDefaultModel,
  isRunningViaNpx,
  showWelcomeMessage
};