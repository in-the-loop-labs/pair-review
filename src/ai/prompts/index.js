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
let level1Fast = null;
let level1Balanced = null;
let level1Thorough = null;
let level2Fast = null;
let level2Balanced = null;
let level2Thorough = null;
let level3Fast = null;
let level3Balanced = null;
let level3Thorough = null;
let orchestrationBalanced = null;
let orchestrationFast = null;
let orchestrationThorough = null;
let consolidationFast = null;
let consolidationBalanced = null;
let consolidationThorough = null;

/**
 * Load a baseline prompt module
 * @param {string} promptType - Prompt type (level1, level2, level3, orchestration, consolidation)
 * @param {string} tier - Capability tier (fast, balanced, thorough)
 * @returns {Object|null} Baseline module or null if not found
 */
function loadBaseline(promptType, tier) {
  // Level 1 Fast
  if (promptType === 'level1' && tier === 'fast') {
    if (!level1Fast) {
      level1Fast = require('./baseline/level1/fast');
    }
    return level1Fast;
  }
  // Level 1 Balanced
  if (promptType === 'level1' && tier === 'balanced') {
    if (!level1Balanced) {
      level1Balanced = require('./baseline/level1/balanced');
    }
    return level1Balanced;
  }
  // Level 1 Thorough
  if (promptType === 'level1' && tier === 'thorough') {
    if (!level1Thorough) {
      level1Thorough = require('./baseline/level1/thorough');
    }
    return level1Thorough;
  }
  // Level 2 Fast
  if (promptType === 'level2' && tier === 'fast') {
    if (!level2Fast) {
      level2Fast = require('./baseline/level2/fast');
    }
    return level2Fast;
  }
  // Level 2 Balanced
  if (promptType === 'level2' && tier === 'balanced') {
    if (!level2Balanced) {
      level2Balanced = require('./baseline/level2/balanced');
    }
    return level2Balanced;
  }
  // Level 2 Thorough
  if (promptType === 'level2' && tier === 'thorough') {
    if (!level2Thorough) {
      level2Thorough = require('./baseline/level2/thorough');
    }
    return level2Thorough;
  }
  // Level 3 Fast
  if (promptType === 'level3' && tier === 'fast') {
    if (!level3Fast) {
      level3Fast = require('./baseline/level3/fast');
    }
    return level3Fast;
  }
  // Level 3 Balanced
  if (promptType === 'level3' && tier === 'balanced') {
    if (!level3Balanced) {
      level3Balanced = require('./baseline/level3/balanced');
    }
    return level3Balanced;
  }
  // Level 3 Thorough
  if (promptType === 'level3' && tier === 'thorough') {
    if (!level3Thorough) {
      level3Thorough = require('./baseline/level3/thorough');
    }
    return level3Thorough;
  }
  // Orchestration Fast
  if (promptType === 'orchestration' && tier === 'fast') {
    if (!orchestrationFast) {
      orchestrationFast = require('./baseline/orchestration/fast');
    }
    return orchestrationFast;
  }
  // Orchestration Balanced
  if (promptType === 'orchestration' && tier === 'balanced') {
    if (!orchestrationBalanced) {
      orchestrationBalanced = require('./baseline/orchestration/balanced');
    }
    return orchestrationBalanced;
  }
  // Orchestration Thorough
  if (promptType === 'orchestration' && tier === 'thorough') {
    if (!orchestrationThorough) {
      orchestrationThorough = require('./baseline/orchestration/thorough');
    }
    return orchestrationThorough;
  }
  // Consolidation Fast
  if (promptType === 'consolidation' && tier === 'fast') {
    if (!consolidationFast) {
      consolidationFast = require('./baseline/consolidation/fast');
    }
    return consolidationFast;
  }
  // Consolidation Balanced
  if (promptType === 'consolidation' && tier === 'balanced') {
    if (!consolidationBalanced) {
      consolidationBalanced = require('./baseline/consolidation/balanced');
    }
    return consolidationBalanced;
  }
  // Consolidation Thorough
  if (promptType === 'consolidation' && tier === 'thorough') {
    if (!consolidationThorough) {
      consolidationThorough = require('./baseline/consolidation/thorough');
    }
    return consolidationThorough;
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
 * @param {string} promptType - Prompt type (level1, level2, level3, orchestration, consolidation)
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
