// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AI Provider Abstraction Layer
 *
 * Defines a common interface for AI providers (Claude, Gemini, etc.)
 * and provides a factory function to create provider instances.
 */

const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

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
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    tagline: 'Best Available',
    description: 'The most capable models for critical reviews',
    badge: 'Premium',
    badgeClass: 'badge-premium'
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
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @param {Function} options.registerProcess - Function to register child process for cancellation
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

  /**
   * Get the "fast" tier model for this provider, with fallback to analysis model.
   * Used for auxiliary tasks like JSON extraction where speed matters more than depth.
   * @returns {string} Model ID for extraction
   */
  getFastTierModel() {
    const models = this.constructor.getModels();
    const fastModel = models.find(m => m.tier === 'fast');
    if (fastModel) {
      return fastModel.id;
    }
    // Fall back to the analysis model if no fast tier exists
    logger.debug(`No fast-tier model found for ${this.constructor.getProviderId()}, using analysis model: ${this.model}`);
    return this.model;
  }

  /**
   * Get CLI configuration for LLM extraction. Override in subclasses to enable extraction.
   * @param {string} model - The model to use for extraction
   * @returns {Object|null} Configuration object or null if extraction not supported
   * @property {string} command - CLI command
   * @property {string[]} args - Arguments (prompt will be appended if promptViaStdin is false)
   * @property {boolean} useShell - Whether to use shell mode
   * @property {boolean} promptViaStdin - If true, send prompt to stdin; if false, append to args
   */
  getExtractionConfig(model) {
    // Default: extraction not supported
    return null;
  }

  /**
   * Extract JSON from raw response using LLM as a fallback when regex strategies fail.
   * This is a common implementation used by all providers that support extraction.
   * @param {string} rawResponse - The raw response text containing embedded JSON
   * @param {Object} options - Optional configuration
   * @param {string|number} options.level - Analysis level for logging
   * @param {string} options.analysisId - Analysis ID for process tracking (enables cancellation)
   * @param {Function} options.registerProcess - Function to register child process for cancellation
   * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
   */
  async extractJSONWithLLM(rawResponse, options = {}) {
    const { level = 'extraction', analysisId, registerProcess } = options;
    const levelPrefix = `[Level ${level}]`;

    // Get the fast-tier model, with fallback to analysis model
    const extractionModel = this.getFastTierModel();

    // Get provider-specific CLI configuration
    const config = this.getExtractionConfig(extractionModel);
    if (!config) {
      return {
        success: false,
        error: `${this.constructor.getProviderId()} does not support LLM extraction`
      };
    }

    const { command, args, useShell, promptViaStdin } = config;
    const prompt = `Extract the JSON object from the following text. Return ONLY the valid JSON, nothing else. Do not include any explanation, markdown formatting, or code blocks - just the raw JSON.

=== BEGIN INPUT TEXT ===
${rawResponse}
=== END INPUT TEXT ===`;

    return new Promise((resolve) => {
      // Build final command and args based on prompt delivery method
      const finalArgs = promptViaStdin ? args : [...args, prompt];

      logger.info(`${levelPrefix} Attempting LLM-based JSON extraction with ${extractionModel}...`);

      const proc = spawn(command, finalArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, proc);
        logger.info(`${levelPrefix} Registered extraction process ${proc.pid} for analysis ${analysisId}`);
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = 60000; // 60 second timeout for extraction

      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        logger.warn(`${levelPrefix} LLM extraction timed out after ${timeout}ms`);
        proc.kill('SIGTERM');
        settle({ success: false, error: 'LLM extraction timed out' });
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (settled) return;

        if (code !== 0) {
          logger.warn(`${levelPrefix} LLM extraction process exited with code ${code}`);
          if (stderr.trim()) {
            logger.warn(`${levelPrefix} LLM extraction stderr: ${stderr}`);
          }
          settle({ success: false, error: `Process exited with code ${code}` });
          return;
        }

        // Use the generic extractJSON for all providers - the LLM should return raw JSON
        const extracted = extractJSON(stdout, level);
        if (extracted.success) {
          logger.success(`${levelPrefix} LLM extraction successful`);
          settle(extracted);
        } else {
          logger.warn(`${levelPrefix} LLM extraction returned unparseable response`);
          if (stderr.trim()) {
            logger.warn(`${levelPrefix} LLM extraction stderr: ${stderr}`);
          }
          settle({ success: false, error: 'LLM extraction returned unparseable response' });
        }
      });

      proc.on('error', (error) => {
        logger.warn(`${levelPrefix} LLM extraction process error: ${error.message}`);
        settle({ success: false, error: error.message });
      });

      // Send prompt via stdin if configured
      if (promptViaStdin) {
        proc.stdin.write(prompt, (err) => {
          if (err) {
            logger.warn(`${levelPrefix} Failed to write extraction prompt: ${err}`);
            proc.kill('SIGTERM');
            settle({ success: false, error: `Failed to write prompt: ${err}` });
          }
        });
        proc.stdin.end();
      }
    });
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
 * Get tier for a specific model from a provider
 * Queries the provider's model definitions to find the tier
 * @param {string} providerId - Provider ID (e.g., 'claude', 'gemini')
 * @param {string} modelId - Model ID (e.g., 'sonnet', 'gemini-2.5-pro')
 * @returns {string|null} Tier name or null if provider or model not found
 */
function getTierForModel(providerId, modelId) {
  const ProviderClass = providerRegistry.get(providerId);
  if (!ProviderClass) {
    return null;
  }

  const models = ProviderClass.getModels();
  const model = models.find(m => m.id === modelId);
  return model?.tier || null;
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
  getTierForModel,
  testProviderAvailability
};
