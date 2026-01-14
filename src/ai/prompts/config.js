// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prompt optimization configuration
 *
 * Defines tier mappings and provider configurations for the prompt system.
 */

/**
 * Capability tiers map user-friendly names to internal tier identifiers
 */
const TIER_ALIASES = {
  free: 'fast',
  standard: 'balanced',
  premium: 'thorough'
};

/**
 * Internal capability tiers
 */
const TIERS = ['fast', 'balanced', 'thorough'];

/**
 * Prompt types (analysis levels)
 */
const PROMPT_TYPES = ['level1', 'level2', 'level3', 'orchestration'];

/**
 * Provider configurations
 * Maps provider IDs to their model tier mappings
 */
const PROVIDERS = {
  claude: {
    name: 'Anthropic Claude',
    models: {
      'haiku': { tier: 'fast' },
      'sonnet': { tier: 'balanced' },
      'opus': { tier: 'thorough' }
    },
    isBaseline: true // Claude prompts are canonical
  },
  gemini: {
    name: 'Google Gemini',
    models: {
      'gemini-2.0-flash': { tier: 'fast' },
      'gemini-2.5-pro': { tier: 'balanced' },
      'gemini-ultra': { tier: 'thorough' }
    }
  },
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-4o-mini': { tier: 'fast' },
      'gpt-4o': { tier: 'balanced' },
      'o1': { tier: 'thorough' }
    }
  }
};

/**
 * Resolve a user-friendly tier alias to internal tier
 * @param {string} tierOrAlias - Tier name or alias
 * @returns {string} Internal tier name
 */
function resolveTier(tierOrAlias) {
  return TIER_ALIASES[tierOrAlias] || tierOrAlias;
}

/**
 * Get tier for a specific model
 * @param {string} providerId - Provider ID
 * @param {string} model - Model name
 * @returns {string|null} Tier name or null if not found
 */
function getTierForModel(providerId, model) {
  const provider = PROVIDERS[providerId];
  if (!provider || !provider.models[model]) {
    return null;
  }
  return provider.models[model].tier;
}

module.exports = {
  TIER_ALIASES,
  TIERS,
  PROMPT_TYPES,
  PROVIDERS,
  resolveTier,
  getTierForModel
};
