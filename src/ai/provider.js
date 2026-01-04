/**
 * AI Provider Abstraction Layer
 *
 * Defines a common interface for AI providers (Claude, Gemini, etc.)
 * and provides a factory function to create provider instances.
 */

const logger = require('../utils/logger');

/**
 * Model tier definitions - provider-agnostic tiers that map to specific models
 */
const MODEL_TIERS = {
  fast: {
    id: 'fast',
    name: 'Fast',
    tagline: 'Lightning Fast',
    description: 'Quick analysis for simple changes',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    tagline: 'Best Balance',
    description: 'Recommended for most reviews',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  thorough: {
    id: 'thorough',
    name: 'Thorough',
    tagline: 'Most Capable',
    description: 'Deep analysis for complex code',
    badge: 'Most Thorough',
    badgeClass: 'badge-power'
  }
};

/**
 * Base class for AI providers
 * All providers must implement these methods
 */
class AIProvider {
  /**
   * @param {string} model - The model identifier to use
   */
  constructor(model) {
    if (new.target === AIProvider) {
      throw new Error('AIProvider is an abstract class and cannot be instantiated directly');
    }
    this.model = model;
  }

  /**
   * Execute a prompt and return the parsed response
   * @param {string} prompt - The prompt to send to the AI
   * @param {Object} options - Execution options
   * @param {string} options.cwd - Working directory for execution
   * @param {number} options.timeout - Timeout in milliseconds
   * @param {string|number} options.level - Analysis level for logging
   * @returns {Promise<Object>} Parsed JSON response or { raw, parsed: false }
   */
  async execute(prompt, options = {}) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Test if the provider's CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    throw new Error('testAvailability() must be implemented by subclass');
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  static getProviderName() {
    throw new Error('getProviderName() must be implemented by subclass');
  }

  /**
   * Get the provider ID (used in config)
   * @returns {string}
   */
  static getProviderId() {
    throw new Error('getProviderId() must be implemented by subclass');
  }

  /**
   * Get available models for this provider
   * Returns an array of model definitions with tier mappings
   * @returns {Array<Object>}
   */
  static getModels() {
    throw new Error('getModels() must be implemented by subclass');
  }

  /**
   * Get the default model for this provider
   * @returns {string}
   */
  static getDefaultModel() {
    throw new Error('getDefaultModel() must be implemented by subclass');
  }

  /**
   * Get installation instructions for this provider's CLI
   * @returns {string}
   */
  static getInstallInstructions() {
    throw new Error('getInstallInstructions() must be implemented by subclass');
  }
}

/**
 * Registry of available providers
 * Providers register themselves here when loaded
 */
const providerRegistry = new Map();

/**
 * Register a provider class
 * @param {string} id - Provider ID (e.g., 'claude', 'gemini')
 * @param {typeof AIProvider} providerClass - The provider class
 */
function registerProvider(id, providerClass) {
  providerRegistry.set(id, providerClass);
  logger.debug(`Registered AI provider: ${id}`);
}

/**
 * Get a registered provider class by ID
 * @param {string} id - Provider ID
 * @returns {typeof AIProvider|undefined}
 */
function getProviderClass(id) {
  return providerRegistry.get(id);
}

/**
 * Get all registered provider IDs
 * @returns {string[]}
 */
function getRegisteredProviderIds() {
  return Array.from(providerRegistry.keys());
}

/**
 * Get provider info for all registered providers
 * @returns {Array<Object>}
 */
function getAllProvidersInfo() {
  const providers = [];
  for (const [id, ProviderClass] of providerRegistry) {
    providers.push({
      id,
      name: ProviderClass.getProviderName(),
      models: ProviderClass.getModels(),
      defaultModel: ProviderClass.getDefaultModel(),
      installInstructions: ProviderClass.getInstallInstructions()
    });
  }
  return providers;
}

/**
 * Create a provider instance
 * @param {string} providerId - Provider ID (e.g., 'claude', 'gemini')
 * @param {string} model - Model to use (optional, uses default if not specified)
 * @returns {AIProvider}
 * @throws {Error} If provider is not registered
 */
function createProvider(providerId, model = null) {
  const ProviderClass = providerRegistry.get(providerId);

  if (!ProviderClass) {
    const available = getRegisteredProviderIds().join(', ');
    throw new Error(`Unknown AI provider: ${providerId}. Available providers: ${available}`);
  }

  const actualModel = model || ProviderClass.getDefaultModel();
  return new ProviderClass(actualModel);
}

/**
 * Test availability of a provider with timeout
 * @param {string} providerId - Provider ID
 * @param {number} timeout - Timeout in milliseconds (default 10 seconds)
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function testProviderAvailability(providerId, timeout = 10000) {
  try {
    const provider = createProvider(providerId);

    // Race between availability test and timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Provider test timed out')), timeout);
    });

    const available = await Promise.race([
      provider.testAvailability(),
      timeoutPromise
    ]);

    return { available };
  } catch (error) {
    const ProviderClass = providerRegistry.get(providerId);
    const installInstructions = ProviderClass?.getInstallInstructions() || 'Check the provider documentation.';
    return {
      available: false,
      error: error.message,
      installInstructions
    };
  }
}

module.exports = {
  AIProvider,
  MODEL_TIERS,
  registerProvider,
  getProviderClass,
  getRegisteredProviderIds,
  getAllProvidersInfo,
  createProvider,
  testProviderAvailability
};
