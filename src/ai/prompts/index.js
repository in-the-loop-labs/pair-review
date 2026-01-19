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

const fs = require('fs');
const path = require('path');
const { TIERS, PROMPT_TYPES, resolveTier } = require('./config');
const { applyDelta } = require('./section-parser');
const logger = require('../../utils/logger');

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

// Variant cache: Map<"provider/promptType/tier", variant>
const variantCache = new Map();

/**
 * Load a variant file if it exists
 *
 * Variants are organized by provider, prompt type, and tier.
 * Directory structure: variants/{provider}/{promptType}/{tier}.json
 *   e.g., variants/gemini/level1/fast.json
 *
 * @param {string} provider - Provider ID (gemini, openai, codex, claude)
 * @param {string} promptType - Prompt type (level1, level2, level3, orchestration)
 * @param {string} tier - Capability tier (fast, balanced, thorough)
 * @returns {Object|null} Variant object or null if not found
 */
function loadVariant(provider, promptType, tier) {
  // Claude uses baselines directly
  if (provider === 'claude') {
    return null;
  }

  // Check cache first (keyed by provider/promptType/tier)
  const cacheKey = `${provider}/${promptType}/${tier}`;
  if (variantCache.has(cacheKey)) {
    return variantCache.get(cacheKey);
  }

  // Construct variant file path directly: variants/{provider}/{promptType}/{tier}.json
  const variantPath = path.join(__dirname, 'variants', provider, promptType, `${tier}.json`);

  try {
    if (fs.existsSync(variantPath)) {
      const content = fs.readFileSync(variantPath, 'utf-8');
      const variant = JSON.parse(content);
      variantCache.set(cacheKey, variant);
      return variant;
    }
  } catch (error) {
    // Log but don't throw - fall back to baseline
    logger.warn(`Failed to load variant ${variantPath}: ${error.message}`);
  }

  variantCache.set(cacheKey, null);
  return null;
}

/**
 * Load a baseline prompt module
 * @param {string} promptType - Prompt type (level1, level2, level3, orchestration)
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
 * @param {Object} options - Optional configuration
 * @param {string} options.provider - Provider ID (default: 'claude')
 * @param {string} options.model - Model ID for variant selection (e.g., 'gemini-3-flash-preview')
 * @returns {Object|null} Prompt builder object or null if not available
 */
function getPromptBuilder(promptType, tier, options = {}) {
  // Handle legacy call signature: getPromptBuilder(type, tier, provider)
  const opts = typeof options === 'string'
    ? { provider: options }
    : options;

  // Resolve provider and model with explicit defaults
  // Note: model parameter reserved for future per-model variant selection
  const resolvedProvider = opts.provider ?? 'claude';
  const resolvedModel = opts.model ?? null;
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

  // Load variant if available for non-Claude providers
  // Variants are tier-based, so we don't need the specific model ID
  const variant = resolvedProvider !== 'claude' ? loadVariant(resolvedProvider, promptType, resolvedTier) : null;

  return {
    promptType,
    tier: resolvedTier,
    provider: resolvedProvider,
    model: resolvedModel,
    hasVariant: variant !== null,

    /**
     * Get the tagged prompt template (with XML section markers)
     * Returns baseline template (variants are applied during build)
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
     * If a variant exists, applies delta transformations
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
      // Interpolate placeholders in baseline
      const interpolated = interpolate(baseline.taggedPrompt, context);

      let plainPrompt;
      if (variant && variant.delta) {
        // Apply variant delta to produce optimized prompt
        plainPrompt = applyDelta(interpolated, variant.delta);
      } else {
        // No variant - strip XML section tags for final output
        plainPrompt = stripSectionTags(interpolated);
      }

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
    },

    /**
     * Get variant metadata if one is loaded
     * @returns {Object|null} Variant metadata or null
     */
    getVariantMeta() {
      return variant ? variant.meta : null;
    }
  };
}

module.exports = {
  getPromptBuilder,
  isPromptAvailable,
  interpolate,
  stripSectionTags
};
