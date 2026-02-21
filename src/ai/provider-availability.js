// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Provider Availability Module
 *
 * Manages checking of AI provider availability at server startup.
 * Caches results and exposes them for the /api/providers endpoint.
 */

const logger = require('../utils/logger');
const { getRegisteredProviderIds, testProviderAvailability, getProviderClass } = require('./provider');

/**
 * Cache of provider availability status
 * Map<providerId, { available: boolean, error?: string, checkedAt: number }>
 */
const availabilityCache = new Map();

/**
 * Whether a check is currently in progress
 */
let checkInProgress = false;

/**
 * Get cached availability status for a provider
 * @param {string} providerId - Provider ID
 * @returns {{available: boolean, error?: string, checkedAt: number} | null}
 */
function getCachedAvailability(providerId) {
  return availabilityCache.get(providerId) || null;
}

/**
 * Get all cached availability statuses
 * @returns {Object} Map of providerId to availability status
 */
function getAllCachedAvailability() {
  const result = {};
  for (const [providerId, status] of availabilityCache) {
    result[providerId] = status;
  }
  return result;
}

/**
 * Check availability of a single provider and cache the result
 * Uses testProviderAvailability from provider.js which handles timeout and error capture
 * @param {string} providerId - Provider ID
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function checkProviderAvailability(providerId) {
  // Use the centralized testProviderAvailability which handles timeout and error capture
  const result = await testProviderAvailability(providerId);

  const status = {
    available: result.available,
    checkedAt: Date.now()
  };

  if (!result.available) {
    // Preserve specific error message if available, otherwise use generic message
    status.error = result.error || 'CLI not available or not authenticated';
    status.installInstructions = result.installInstructions ||
      (getProviderClass(providerId)?.getInstallInstructions() || 'Check provider documentation');
  }

  availabilityCache.set(providerId, status);
  return status;
}

/**
 * Check availability of all registered providers
 * Optionally prioritizes a specific provider (e.g., the configured default)
 * @param {string} [priorityProviderId] - Provider to check first
 * @returns {Promise<void>}
 */
async function checkAllProviders(priorityProviderId = null) {
  if (checkInProgress) {
    logger.debug('Provider availability check already in progress, skipping');
    return;
  }

  checkInProgress = true;

  try {
    const providerIds = getRegisteredProviderIds();

    logger.info(`Checking availability of ${providerIds.length} AI providers...`);

    // If a priority provider is specified and exists, check it first
    if (priorityProviderId && providerIds.includes(priorityProviderId)) {
      logger.debug(`Checking priority provider first: ${priorityProviderId}`);
      const status = await checkProviderAvailability(priorityProviderId);
      logger.info(`  ${priorityProviderId}: ${status.available ? 'available' : 'unavailable'}`);
    }

    // Check remaining providers in parallel
    const remainingProviders = providerIds.filter(id => id !== priorityProviderId);
    const results = await Promise.all(
      remainingProviders.map(async (providerId) => {
        const status = await checkProviderAvailability(providerId);
        return { providerId, status };
      })
    );

    // Log results
    for (const { providerId, status } of results) {
      logger.info(`  ${providerId}: ${status.available ? 'available' : 'unavailable'}`);
    }

    // Summary
    const availableCount = Array.from(availabilityCache.values()).filter(s => s.available).length;
    logger.info(`Provider check complete: ${availableCount}/${providerIds.length} available`);
  } finally {
    checkInProgress = false;
  }
}

/**
 * Check if a provider availability check is in progress
 * @returns {boolean}
 */
function isCheckInProgress() {
  return checkInProgress;
}

/**
 * Clear the availability cache
 * Useful for forcing a fresh check
 */
function clearCache() {
  availabilityCache.clear();
}

/**
 * Reset all module state (cache and checkInProgress flag)
 * Primarily useful for testing to ensure clean state between tests
 */
function resetState() {
  availabilityCache.clear();
  checkInProgress = false;
}

module.exports = {
  getCachedAvailability,
  getAllCachedAvailability,
  checkProviderAvailability,
  checkAllProviders,
  isCheckInProgress,
  clearCache,
  resetState
};
