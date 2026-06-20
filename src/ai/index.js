// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
  resolveNonExecutableProviderId,
  getAllProvidersInfo,
  createProvider,
  testProviderAvailability,
  resolveAvailabilityTimeoutMs,
  secondsToTimeoutMs,
  DEFAULT_AVAILABILITY_TIMEOUT_MS,
  applyConfigOverrides,
  getProviderConfigOverrides,
  inferModelDefaults,
  resolveDefaultModel,
  prettifyModelId,
  createAliasedProviderClass,
  getTierForModel
} = require('./provider');

// Load the availability checking module
const {
  getCachedAvailability,
  getAllCachedAvailability,
  checkProviderAvailability: checkSingleProviderAvailability,
  checkAllProviders,
  isCheckInProgress,
  clearCache: clearAvailabilityCache
} = require('./provider-availability');

// Load executable provider factory (used by applyConfigOverrides for dynamic registration)
const { createExecutableProviderClass } = require('./executable-provider');

// Load and register all providers
// Each provider self-registers when loaded
require('./claude-provider');
require('./gemini-provider');
require('./codex-provider');
require('./copilot-provider');
require('./opencode-provider');
require('./cursor-agent-provider');
require('./pi-provider');

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
  resolveNonExecutableProviderId,
  getAllProvidersInfo,

  // Factory
  createProvider,

  // Utilities
  testProviderAvailability,
  resolveAvailabilityTimeoutMs,
  secondsToTimeoutMs,
  DEFAULT_AVAILABILITY_TIMEOUT_MS,

  // Config override support
  applyConfigOverrides,
  getProviderConfigOverrides,
  inferModelDefaults,
  resolveDefaultModel,
  prettifyModelId,
  getTierForModel,

  // Provider factories
  createExecutableProviderClass,
  createAliasedProviderClass,

  // Provider availability checking
  getCachedAvailability,
  getAllCachedAvailability,
  checkSingleProviderAvailability,
  checkAllProviders,
  isCheckInProgress,
  clearAvailabilityCache
};
