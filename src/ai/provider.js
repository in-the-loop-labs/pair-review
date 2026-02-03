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
   * @param {Function} [options.onStreamEvent] - Callback for real-time stream events.
   *   Called with normalized events: { type: 'assistant_text'|'tool_use', text: string, timestamp: number }.
   *   Providers that support streaming (Claude, Codex) will call this as data arrives.
   *   Providers without streaming support silently ignore this option.
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
 * Stores config overrides per provider (populated by applyConfigOverrides)
 */
const providerConfigOverrides = new Map();

/**
 * Whether yolo mode is enabled (skips fine-grained provider permissions)
 */
let yoloMode = false;

/**
 * Prettify a model ID into a human-readable name
 * @param {string} id - Model ID (e.g., 'anthropic/claude-sonnet-4')
 * @returns {string} - Prettified name (e.g., 'Anthropic Claude Sonnet 4')
 */
function prettifyModelId(id) {
  return id
    .replace(/[/-]/g, ' ')           // Replace slashes and hyphens with spaces
    .replace(/\b\w/g, c => c.toUpperCase());  // Capitalize each word
}

/**
 * Canonical model tiers
 */
const CANONICAL_TIERS = ['fast', 'balanced', 'thorough'];

/**
 * Tier aliases that map to canonical tiers
 */
const TIER_ALIASES = {
  free: 'fast',
  premium: 'thorough'
};

/**
 * All valid tier values (canonical + aliases)
 */
const VALID_TIERS = [...CANONICAL_TIERS, ...Object.keys(TIER_ALIASES)];

/**
 * Normalize a tier to its canonical form
 * @param {string} tier - Tier value (may be alias)
 * @returns {string} - Canonical tier
 */
function normalizeTier(tier) {
  return TIER_ALIASES[tier] || tier;
}

/**
 * Infer default values for a model definition
 * Fills in missing optional fields based on id and tier
 * @param {Object} model - Model definition with at least id and tier
 * @returns {Object} - Model definition with inferred defaults
 * @throws {Error} If tier is missing or invalid
 */
function inferModelDefaults(model) {
  // Validate required tier field
  if (!model.tier) {
    throw new Error(`Model "${model.id}" is missing required "tier" field. Valid tiers: ${VALID_TIERS.join(', ')}`);
  }
  if (!VALID_TIERS.includes(model.tier)) {
    throw new Error(`Model "${model.id}" has invalid tier "${model.tier}". Valid tiers: ${VALID_TIERS.join(', ')}`);
  }

  const tierDefaults = {
    fast: { badge: 'Fastest', badgeClass: 'badge-speed' },
    balanced: { badge: 'Recommended', badgeClass: 'badge-recommended' },
    thorough: { badge: 'Most Thorough', badgeClass: 'badge-power' }
  };

  const canonicalTier = normalizeTier(model.tier);
  const tierInfo = tierDefaults[canonicalTier];

  return {
    ...model,
    tier: canonicalTier, // Normalize tier alias to canonical form
    name: model.name || prettifyModelId(model.id),
    tagline: model.tagline || '',
    description: model.description || '',
    badge: model.badge || tierInfo.badge,
    badgeClass: model.badgeClass || tierInfo.badgeClass
  };
}

/**
 * Resolve the default model from an array of model definitions
 * Priority: model with default:true > first balanced tier model > first model
 * @param {Array<Object>} models - Array of model definitions
 * @returns {string|null} - Default model ID or null if no models
 */
function resolveDefaultModel(models) {
  if (!models || models.length === 0) {
    return null;
  }

  // First, look for a model explicitly marked as default
  const explicitDefault = models.find(m => m.default === true);
  if (explicitDefault) {
    return explicitDefault.id;
  }

  // Fall back to first balanced tier model
  const balancedModel = models.find(m => m.tier === 'balanced');
  if (balancedModel) {
    return balancedModel.id;
  }

  // Fall back to first model in array
  return models[0].id;
}

/**
 * Apply configuration overrides for all providers
 * Call this after all providers have registered and config is loaded
 * Clears any existing overrides before applying new ones.
 * @param {Object} config - Configuration object from loadConfig()
 */
function applyConfigOverrides(config) {
  // Clear existing overrides to ensure clean state
  providerConfigOverrides.clear();

  // Apply yolo mode from config or environment
  // Also check env var: server.js reloads config from disk independently,
  // so the env var carries the CLI --yolo flag across that boundary
  yoloMode = !!(config.yolo || process.env.PAIR_REVIEW_YOLO === 'true');
  if (yoloMode) {
    logger.debug('Yolo mode enabled: skipping fine-grained provider permissions');
  }

  const providersConfig = config.providers || {};

  for (const [providerId, providerConfig] of Object.entries(providersConfig)) {
    logger.debug(`Applying config overrides for provider: ${providerId}`);

    // Process models if specified - infer defaults for each
    let processedModels = null;
    if (Array.isArray(providerConfig.models) && providerConfig.models.length > 0) {
      processedModels = providerConfig.models.map(inferModelDefaults);
      logger.debug(`Configured ${processedModels.length} models for ${providerId}`);
    }

    // Store the overrides
    providerConfigOverrides.set(providerId, {
      command: providerConfig.command,
      installInstructions: providerConfig.installInstructions,
      extra_args: providerConfig.extra_args,
      env: providerConfig.env,
      models: processedModels
    });
  }

  logger.debug(`Applied config overrides for ${Object.keys(providersConfig).length} providers`);
}

/**
 * Get config overrides for a specific provider
 * @param {string} providerId - Provider ID
 * @returns {Object|undefined} - Config overrides or undefined
 */
function getProviderConfigOverrides(providerId) {
  return providerConfigOverrides.get(providerId);
}

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
 * Uses config overrides for models/installInstructions if available
 * @returns {Array<Object>}
 */
function getAllProvidersInfo() {
  const providers = [];
  for (const [id, ProviderClass] of providerRegistry) {
    const overrides = providerConfigOverrides.get(id);

    // Use overridden models if available, otherwise use built-in
    const models = overrides?.models || ProviderClass.getModels();

    // Resolve default model from (potentially overridden) models array
    const defaultModel = resolveDefaultModel(models) || ProviderClass.getDefaultModel();

    // Use overridden install instructions if available
    const installInstructions = overrides?.installInstructions || ProviderClass.getInstallInstructions();

    providers.push({
      id,
      name: ProviderClass.getProviderName(),
      models,
      defaultModel,
      installInstructions
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

  // Get config overrides for this provider
  const overrides = providerConfigOverrides.get(providerId);

  // Determine the actual model to use
  let actualModel = model;
  if (!actualModel) {
    // If models are overridden, resolve default from them
    if (overrides?.models) {
      actualModel = resolveDefaultModel(overrides.models);
    }
    // Fall back to provider's built-in default
    if (!actualModel) {
      actualModel = ProviderClass.getDefaultModel();
    }
  }

  // Create provider instance with config overrides
  return new ProviderClass(actualModel, { ...(overrides || {}), yolo: yoloMode });
}

/**
 * Get tier for a specific model from a provider
 * Queries the provider's model definitions (or config overrides) to find the tier
 * @param {string} providerId - Provider ID (e.g., 'claude', 'gemini')
 * @param {string} modelId - Model ID (e.g., 'sonnet', 'gemini-2.5-pro')
 * @returns {string|null} Tier name or null if provider or model not found
 */
function getTierForModel(providerId, modelId) {
  const ProviderClass = providerRegistry.get(providerId);
  if (!ProviderClass) {
    return null;
  }

  // Use overridden models if available
  const overrides = providerConfigOverrides.get(providerId);
  const models = overrides?.models || ProviderClass.getModels();

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
  testProviderAvailability,
  // Config override support
  applyConfigOverrides,
  getProviderConfigOverrides,
  inferModelDefaults,
  resolveDefaultModel,
  prettifyModelId
};
