const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.pair-review');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  github_token: "",
  port: 3000,
  theme: "light",
  provider: "claude",  // AI provider: 'claude' or 'gemini'
  model: "sonnet",     // Model within the provider (e.g., 'sonnet' for Claude, 'gemini-2.5-pro' for Gemini)
  worktree_retention_days: 7,
  dev_mode: false  // When true, disables static file caching for development
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
 * Ensures the config directory exists
 */
async function ensureConfigDir() {
  try {
    await fs.access(CONFIG_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        console.log(`Created config directory: ${CONFIG_DIR}`);
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
 * @returns {Object} - Configuration object
 */
async function loadConfig() {
  await ensureConfigDir();
  
  try {
    const configData = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(configData);
    
    // Merge with defaults to ensure all keys exist
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    
    // Validate port
    if (!validatePort(mergedConfig.port)) {
      console.error(`Invalid port number ${mergedConfig.port}`);
      process.exit(1);
    }
    
    return mergedConfig;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Config file doesn't exist, create it with defaults
      const config = { ...DEFAULT_CONFIG };
      await saveConfig(config);
      console.log(`Created default config file: ${CONFIG_FILE}`);
      return config;
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

module.exports = {
  loadConfig,
  saveConfig,
  getConfigDir,
  validatePort
};