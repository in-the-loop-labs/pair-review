// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Chat Provider Registry
 *
 * Defines named chat providers (Pi, Copilot, Gemini, OpenCode) with their
 * default commands/args, config overrides, and availability checks.
 */

const { spawn } = require('child_process');
const { getCachedAvailability } = require('../ai');
const logger = require('../utils/logger');

// Default dependencies (overridable for testing)
const defaults = { spawn };

/**
 * Built-in chat provider definitions.
 * ACP providers communicate over stdin/stdout using the Agent Client Protocol.
 */
const CHAT_PROVIDERS = {
  pi: {
    id: 'pi',
    name: 'Pi',
    type: 'pi',
  },
  'copilot-acp': {
    id: 'copilot-acp',
    name: 'Copilot',
    type: 'acp',
    command: 'copilot',
    args: ['--acp', '--stdio'],
    env: {},
  },
  'gemini-acp': {
    id: 'gemini-acp',
    name: 'Gemini',
    type: 'acp',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: {},
  },
  'opencode-acp': {
    id: 'opencode-acp',
    name: 'OpenCode',
    type: 'acp',
    command: 'opencode',
    args: ['acp'],
    env: {},
  },
};

/** Stored config overrides from `config.providers` */
let _configOverrides = {};

/** Availability cache: { [providerId]: { available: boolean, error?: string } } */
const _availabilityCache = {};

/**
 * Store config overrides that will be merged into provider definitions.
 * Call once at startup with `config.providers || {}`.
 * @param {Object} providersConfig - e.g. { 'copilot-acp': { command: '/usr/local/bin/copilot' } }
 */
function applyConfigOverrides(providersConfig) {
  _configOverrides = providersConfig || {};
}

/**
 * Get a chat provider definition with config overrides merged.
 * @param {string} id - Provider ID (e.g. 'copilot-acp')
 * @returns {Object|null} Provider definition or null if unknown
 */
function getChatProvider(id) {
  const base = CHAT_PROVIDERS[id];
  if (!base) return null;

  const overrides = _configOverrides[id];
  if (!overrides) return { ...base };

  const merged = { ...base };
  if (overrides.command) merged.command = overrides.command;
  if (overrides.env) merged.env = { ...merged.env, ...overrides.env };
  if (overrides.args) {
    merged.args = overrides.args;
  }
  // extra_args appends to the default/overridden args
  if (overrides.extra_args && Array.isArray(overrides.extra_args)) {
    merged.args = [...(merged.args || []), ...overrides.extra_args];
  }
  return merged;
}

/**
 * Get all chat provider definitions (with overrides applied).
 * @returns {Array<Object>}
 */
function getAllChatProviders() {
  return Object.keys(CHAT_PROVIDERS).map(id => getChatProvider(id));
}

/**
 * Check if a provider ID corresponds to an ACP provider.
 * @param {string} id
 * @returns {boolean}
 */
function isAcpProvider(id) {
  const provider = CHAT_PROVIDERS[id];
  return provider?.type === 'acp';
}

/**
 * Check availability of a single chat provider.
 * For Pi, delegates to the existing AI provider availability cache.
 * For ACP providers, spawns `<command> --version` to verify the binary exists.
 * @param {string} id - Provider ID
 * @param {Object} [_deps] - Dependency overrides for testing
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function checkChatProviderAvailability(id, _deps) {
  const provider = getChatProvider(id);
  if (!provider) {
    return { available: false, error: `Unknown provider: ${id}` };
  }

  // Pi delegates to existing AI provider availability
  if (provider.type === 'pi') {
    const cached = getCachedAvailability('pi');
    return { available: cached?.available || false, error: cached?.error };
  }

  const deps = { ...defaults, ..._deps };
  const command = provider.command;

  return new Promise((resolve) => {
    try {
      const proc = deps.spawn(command, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });

      proc.on('error', (err) => {
        resolve({ available: false, error: err.message });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ available: true });
        } else {
          resolve({ available: false, error: `${command} --version exited with code ${code}` });
        }
      });
    } catch (err) {
      resolve({ available: false, error: err.message });
    }
  });
}

/**
 * Check availability of all chat providers in parallel and populate cache.
 * @param {Object} [_deps] - Dependency overrides for testing
 * @returns {Promise<void>}
 */
async function checkAllChatProviders(_deps) {
  const ids = Object.keys(CHAT_PROVIDERS);
  const results = await Promise.all(
    ids.map(async (id) => {
      const result = await checkChatProviderAvailability(id, _deps);
      return { id, result };
    })
  );

  for (const { id, result } of results) {
    _availabilityCache[id] = result;
    if (result.available) {
      logger.info(`[ChatProviders] ${id}: available`);
    } else {
      logger.debug(`[ChatProviders] ${id}: not available${result.error ? ` (${result.error})` : ''}`);
    }
  }
}

/**
 * Get cached availability for a single chat provider.
 * @param {string} id
 * @returns {{available: boolean, error?: string}|null}
 */
function getCachedChatAvailability(id) {
  return _availabilityCache[id] || null;
}

/**
 * Get all cached chat provider availability.
 * @returns {Object} Map of provider ID to availability result
 */
function getAllCachedChatAvailability() {
  return { ..._availabilityCache };
}

/**
 * Clear the availability cache (for testing).
 */
function clearChatAvailabilityCache() {
  for (const key of Object.keys(_availabilityCache)) {
    delete _availabilityCache[key];
  }
}

/**
 * Reset config overrides (for testing).
 */
function clearConfigOverrides() {
  _configOverrides = {};
}

module.exports = {
  getChatProvider,
  getAllChatProviders,
  isAcpProvider,
  checkChatProviderAvailability,
  checkAllChatProviders,
  getCachedChatAvailability,
  getAllCachedChatAvailability,
  applyConfigOverrides,
  clearChatAvailabilityCache,
  clearConfigOverrides,
};
