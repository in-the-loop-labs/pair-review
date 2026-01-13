/**
 * AI Provider Module
 *
 * Central module for AI provider management.
 * Loads all providers and exports the unified API.
 */

// Load the base provider module
const {
  AIProvider,
  MODEL_TIERS,
  registerProvider,
  getProviderClass,
  getRegisteredProviderIds,
  getAllProvidersInfo,
  createProvider,
  testProviderAvailability
} = require('./provider');

// Load and register all providers
// Each provider self-registers when loaded
require('./claude-provider');
require('./gemini-provider');
require('./codex-provider');
require('./copilot-provider');
require('./cursor-agent-provider');

// Export the unified API
module.exports = {
  // Base class (for type checking or extension)
  AIProvider,

  // Tier definitions
  MODEL_TIERS,

  // Provider management
  registerProvider,
  getProviderClass,
  getRegisteredProviderIds,
  getAllProvidersInfo,

  // Factory
  createProvider,

  // Utilities
  testProviderAvailability
};
