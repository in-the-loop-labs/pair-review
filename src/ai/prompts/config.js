// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prompt optimization configuration
 *
 * Defines tier mappings for the prompt system.
 * Note: Provider-specific model-to-tier mappings are defined in each provider's
 * getModels() method. Use getTierForModel() from src/ai/provider.js to query them.
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
 * Resolve a user-friendly tier alias to internal tier
 * @param {string} tierOrAlias - Tier name or alias
 * @returns {string} Internal tier name
 */
function resolveTier(tierOrAlias) {
  if (TIER_ALIASES[tierOrAlias]) {
    return TIER_ALIASES[tierOrAlias];
  }
  if (TIERS.includes(tierOrAlias)) {
    return tierOrAlias;
  }
  // Unknown tier - fall back to balanced with warning
  const logger = require('../../utils/logger');
  logger.warn(`Unknown tier "${tierOrAlias}", falling back to "balanced"`);
  return 'balanced';
}

module.exports = {
  TIER_ALIASES,
  TIERS,
  PROMPT_TYPES,
  resolveTier
};
