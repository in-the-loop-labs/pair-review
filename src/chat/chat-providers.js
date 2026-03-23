// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Chat Provider Registry
 *
 * Defines named chat providers (Pi, Copilot, Gemini, OpenCode, Claude, Codex, Cursor) with their
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
    name: 'Pi (RPC)',
    type: 'pi',
  },
  'copilot-acp': {
    id: 'copilot-acp',
    name: 'Copilot (ACP)',
    type: 'acp',
    command: 'copilot',
    args: ['--acp', '--stdio'],
    env: {},
  },
  'gemini-acp': {
    id: 'gemini-acp',
    name: 'Gemini (ACP)',
    type: 'acp',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: {},
  },
  'opencode-acp': {
    id: 'opencode-acp',
    name: 'OpenCode (ACP)',
    type: 'acp',
    command: 'opencode',
    args: ['acp'],
    env: {},
  },
  'cursor-acp': {
    id: 'cursor-acp',
    name: 'Cursor (ACP)',
    type: 'acp',
    command: 'agent',
    args: ['acp'],
    env: {},
  },
  claude: {
    id: 'claude',
    name: 'Claude (NDJSON)',
    type: 'claude',
    command: 'claude',
    args: [],
    env: {},
  },
  codex: {
    id: 'codex',
    name: 'Codex (JSON-RPC)',
    type: 'codex',
    command: 'codex',
    // Shell environment config prevents zsh -l from reconstructing PATH,
    // ensuring git-diff-lines and other bin/ scripts remain findable.
    args: [
      'app-server',
      '-c', 'allow_login_shell=false',
      '-c', 'shell_environment_policy.include_only=["PATH","HOME","USER"]',
    ],
    env: {},
  },
};

/** Stored config overrides from `config.chat_providers` */
let _configOverrides = {};

/** Availability cache: { [providerId]: { available: boolean, error?: string } } */
const _availabilityCache = {};

/**
 * Store config overrides that will be merged into provider definitions.
 * Call once at startup with `config.chat_providers || {}`.
 * @param {Object} providersConfig - e.g. { 'copilot-acp': { command: '/usr/local/bin/copilot' } }
 */
function applyConfigOverrides(providersConfig) {
  _configOverrides = providersConfig || {};
}

/**
 * Get a chat provider definition with config overrides merged.
 * Supports both built-in providers and dynamic providers defined entirely in config.
 * @param {string} id - Provider ID (e.g. 'copilot-acp', or a custom ID like 'river')
 * @returns {Object|null} Provider definition or null if unknown
 */
function getChatProvider(id) {
  const base = CHAT_PROVIDERS[id];
  const overrides = _configOverrides[id];

  if (!base && !overrides) return null;

  // Dynamic provider defined entirely in config
  if (!base) {
    const provider = {
      id,
      name: overrides.name || overrides.label || id,
      type: overrides.type || 'acp',
      command: overrides.command || id,
      args: overrides.args || [],
      env: overrides.env || {},
    };
    if (overrides.model) provider.model = overrides.model;
    if (overrides.extra_args && Array.isArray(overrides.extra_args)) {
      provider.args = [...provider.args, ...overrides.extra_args];
    }
    if (provider.command.includes(' ')) {
      provider.useShell = true;
    }
    return provider;
  }

  if (!overrides) return { ...base };

  const merged = { ...base };
  if (overrides.name || overrides.label) merged.name = overrides.name || overrides.label;
  if (overrides.command) merged.command = overrides.command;
  if (overrides.model) merged.model = overrides.model;
  if (overrides.env) merged.env = { ...merged.env, ...overrides.env };
  if (overrides.args) {
    merged.args = overrides.args;
  }
  // extra_args appends to the default/overridden args
  if (overrides.extra_args && Array.isArray(overrides.extra_args)) {
    merged.args = [...(merged.args || []), ...overrides.extra_args];
  }
  // For multi-word commands (e.g. "devx claude"), use shell mode
  if (merged.command && merged.command.includes(' ')) {
    merged.useShell = true;
  }
  return merged;
}

/**
 * Get all chat provider definitions (built-in + dynamic from config).
 * @returns {Array<Object>}
 */
function getAllChatProviders() {
  const ids = new Set([
    ...Object.keys(CHAT_PROVIDERS),
    ...Object.keys(_configOverrides),
  ]);
  return [...ids].map(id => getChatProvider(id)).filter(Boolean);
}

/**
 * Check if a provider ID corresponds to an ACP provider.
 * @param {string} id
 * @returns {boolean}
 */
function isAcpProvider(id) {
  const provider = getChatProvider(id);
  return provider?.type === 'acp';
}

/**
 * Check if a provider ID corresponds to a Claude Code provider.
 * @param {string} id
 * @returns {boolean}
 */
function isClaudeCodeProvider(id) {
  const provider = getChatProvider(id);
  return provider?.type === 'claude';
}

/**
 * Check if a provider ID corresponds to a Codex provider.
 * @param {string} id
 * @returns {boolean}
 */
function isCodexProvider(id) {
  const provider = getChatProvider(id);
  return provider?.type === 'codex';
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

  // Codex uses the same binary-check pattern as ACP providers
  // (falls through to the spawn check below)

  const deps = { ...defaults, ..._deps };
  const command = provider.command;
  const useShell = provider.useShell || false;

  return new Promise((resolve) => {
    try {
      // For multi-word commands, use shell mode
      const spawnCmd = useShell ? `${command} --version` : command;
      const spawnArgs = useShell ? [] : ['--version'];
      const proc = deps.spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        shell: useShell,
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
  const ids = [...new Set([...Object.keys(CHAT_PROVIDERS), ...Object.keys(_configOverrides)])];
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
  isClaudeCodeProvider,
  isCodexProvider,
  checkChatProviderAvailability,
  checkAllChatProviders,
  getCachedChatAvailability,
  getAllCachedChatAvailability,
  applyConfigOverrides,
  clearChatAvailabilityCache,
  clearConfigOverrides,
};
