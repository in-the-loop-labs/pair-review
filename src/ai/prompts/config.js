// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prompt optimization configuration
 *
 * Defines tier mappings for the prompt system.
 * Note: Provider-specific model-to-tier mappings are defined in each provider's
 * getModels() method. The tier is persisted on each analysis_runs record at creation time.
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
 * All accepted tier values (internal tiers + user-facing aliases)
 */
const VALID_TIERS = [...TIERS, ...Object.keys(TIER_ALIASES)];

/**
 * Prompt types (analysis levels)
 */
const PROMPT_TYPES = ['level1', 'level2', 'level3', 'orchestration', 'consolidation'];

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
  throw new Error(`Unknown tier: "${tierOrAlias}". Valid tiers: ${TIERS.join(', ')} (aliases: ${Object.keys(TIER_ALIASES).join(', ')})`);
}

module.exports = {
  TIER_ALIASES,
  TIERS,
  VALID_TIERS,
  PROMPT_TYPES,
  resolveTier
};
