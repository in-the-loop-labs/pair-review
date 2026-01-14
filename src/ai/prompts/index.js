// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prompt Optimization System - Main Entry Point
 *
 * Provides runtime assembly of prompts from baseline templates and variants.
 *
 * Usage:
 *   const { getPromptBuilder } = require('./prompts');
 *   const builder = getPromptBuilder('level2', 'balanced');
 *   const prompt = builder.build(context);
 */

const { TIERS, PROMPT_TYPES, resolveTier } = require('./config');

// Import baseline prompts (lazy-loaded to avoid circular dependencies)
let level2Balanced = null;

/**
 * Load a baseline prompt module
 * @param {string} promptType - Prompt type (level1, level2, level3, orchestration)
 * @param {string} tier - Capability tier (fast, balanced, thorough)
 * @returns {Object|null} Baseline module or null if not found
 */
function loadBaseline(promptType, tier) {
  // Currently only Level 2 Balanced is implemented
  if (promptType === 'level2' && tier === 'balanced') {
    if (!level2Balanced) {
      level2Balanced = require('./baseline/level2/balanced');
    }
    return level2Balanced;
  }
  return null;
}

/**
 * Check if a prompt is available in the new architecture
 * @param {string} promptType - Prompt type
 * @param {string} tier - Capability tier
 * @returns {boolean} True if prompt is available
 */
function isPromptAvailable(promptType, tier) {
  const resolvedTier = resolveTier(tier);
  return loadBaseline(promptType, resolvedTier) !== null;
}

/**
 * Interpolate placeholders in a template string
 * @param {string} template - Template with {{placeholder}} syntax
 * @param {Object} context - Context object with values
 * @returns {string} Interpolated string
 */
function interpolate(template, context) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      const value = context[key];
      // Handle empty/null values gracefully
      if (value === null || value === undefined) {
        return '';
      }
      return value;
    }
    // Leave placeholder as-is if not in context (allows partial interpolation)
    return match;
  });
}

/**
 * Strip XML section tags from prompt, leaving only content
 * @param {string} taggedPrompt - Prompt with XML section tags
 * @returns {string} Plain text prompt
 */
function stripSectionTags(taggedPrompt) {
  // Remove section tags but keep content
  return taggedPrompt
    .replace(/<section[^>]*>/g, '')
    .replace(/<\/section>/g, '')
    .trim();
}

/**
 * Create a prompt builder for a specific prompt type and tier
 *
 * @param {string} promptType - Prompt type (level1, level2, level3, orchestration)
 * @param {string} tier - Capability tier (fast, balanced, thorough) or alias
 * @param {string} provider - Provider ID (default: 'claude')
 * @returns {Object|null} Prompt builder object or null if not available
 */
function getPromptBuilder(promptType, tier, provider = 'claude') {
  const resolvedTier = resolveTier(tier);

  // Validate inputs
  if (!PROMPT_TYPES.includes(promptType)) {
    throw new Error(`Invalid prompt type: ${promptType}. Valid types: ${PROMPT_TYPES.join(', ')}`);
  }
  if (!TIERS.includes(resolvedTier)) {
    throw new Error(`Invalid tier: ${tier} (resolved: ${resolvedTier}). Valid tiers: ${TIERS.join(', ')}`);
  }

  // Load baseline
  const baseline = loadBaseline(promptType, resolvedTier);
  if (!baseline) {
    // Prompt not yet migrated to new architecture
    return null;
  }

  // TODO: Load variant if it exists for non-Claude providers
  // const variant = loadVariant(provider, promptType, resolvedTier);

  return {
    promptType,
    tier: resolvedTier,
    provider,

    /**
     * Get the tagged prompt template (with XML section markers)
     * @returns {string} Tagged prompt template
     */
    getTaggedTemplate() {
      return baseline.taggedPrompt;
    },

    /**
     * Get section metadata
     * @returns {Array<Object>} Section definitions
     */
    getSections() {
      return baseline.sections;
    },

    /**
     * Get default section order
     * @returns {Array<string>} Section names in order
     */
    getDefaultOrder() {
      return baseline.defaultOrder;
    },

    /**
     * Build the final prompt by interpolating context values
     *
     * @param {Object} context - Context values for placeholders
     * @param {string} context.reviewIntro - Review introduction line
     * @param {string} context.prContext - PR context section
     * @param {string} context.customInstructions - Custom instructions (optional)
     * @param {string} context.lineNumberGuidance - Line number guidance
     * @param {string} context.generatedFiles - Generated files section (optional)
     * @param {string} context.validFiles - Formatted list of valid files
     * @returns {string} Final assembled prompt (plain text, no XML tags)
     */
    build(context) {
      // Interpolate placeholders
      const interpolated = interpolate(baseline.taggedPrompt, context);

      // Strip XML section tags for final output
      const plainPrompt = stripSectionTags(interpolated);

      // Clean up extra blank lines from optional sections
      return plainPrompt
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    /**
     * Build the prompt but keep XML section tags (for debugging/optimization)
     * @param {Object} context - Context values for placeholders
     * @returns {string} Prompt with XML section tags preserved
     */
    buildTagged(context) {
      return interpolate(baseline.taggedPrompt, context);
    }
  };
}

module.exports = {
  getPromptBuilder,
  isPromptAvailable,
  interpolate,
  stripSectionTags
};
