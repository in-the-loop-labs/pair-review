// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * AI Provider Abstraction Layer
 *
 * Defines a common interface for AI providers (Claude, Gemini, etc.)
 * and provides a factory function to create provider instances.
 */

const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { TIERS, TIER_ALIASES } = require('./prompts/config');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Quote shell-sensitive arguments for safe shell execution.
 * Any arg containing characters that could be interpreted by the shell
 * (brackets, parentheses, commas, etc.) is wrapped in single quotes
 * with internal single quotes escaped using the POSIX pattern.
 *
 * @param {string[]} args - Array of CLI arguments
 * @returns {string[]} Args with shell-sensitive values quoted
 */
function quoteShellArgs(args) {
  return args.map(arg => {
    if (/[[\]*?(){}$!&|;<>,\s'"\\`#~]/.test(arg)) {
      return `'${arg.replace(/'/g, "'\\''")}'`;
    }
    return arg;
  });
}

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
   * @param {string} [options.logPrefix] - Custom log prefix to use instead of `[Level N]`.
   *   Used by council mode to disambiguate concurrent reviewers (e.g., `[L1 R1]`).
   * @returns {Promise<Object>} Parsed JSON response or { raw, parsed: false }
   */
  async execute(prompt, options = {}) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Test if the provider's CLI is available
   * @param {number} [timeoutMs] - Optional timeout in milliseconds for the
   *   availability probe. Subclasses that spawn a child process should use this
   *   to bound the check (the value is resolved per-provider by
   *   testProviderAvailability). Defaults to DEFAULT_AVAILABILITY_TIMEOUT_MS.
   * @returns {Promise<boolean>}
   */
  async testAvailability(timeoutMs) {
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
    const overrides = providerConfigOverrides.get(this.constructor.getProviderId());
    const models = applyModelOverrides(this.constructor.getModels(), overrides);
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
   * @property {boolean} promptViaFile - If true, write prompt to a temp file and pass @filepath as a positional arg (Pi-specific @file syntax; currently only used by PiProvider)
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
    const { level = 'extraction', analysisId, registerProcess, logPrefix } = options;
    const levelPrefix = logPrefix || `[Level ${level}]`;

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

    const { command, args, useShell, promptViaStdin, promptViaFile, env: configEnv } = config;
    const prompt = `Extract the JSON object from the following text. Return ONLY the valid JSON, nothing else. Do not include any explanation, markdown formatting, or code blocks - just the raw JSON.

=== BEGIN INPUT TEXT ===
${rawResponse}
=== END INPUT TEXT ===`;

    return new Promise((resolve) => {
      // Build final command and args based on prompt delivery method
      // promptViaFile: write to temp file, pass @filepath as positional arg (Pi @file syntax)
      // promptViaStdin: write to process stdin after spawn
      // default: pass prompt as positional CLI arg
      let tmpFile = null;
      let cleanupTmpFile = () => {};
      let finalArgs;

      if (promptViaFile) {
        tmpFile = path.join(os.tmpdir(), `pair-review-extract-${Date.now()}-${process.pid}-${crypto.randomUUID()}.txt`);
        fs.writeFileSync(tmpFile, prompt);
        cleanupTmpFile = () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } };
        finalArgs = [...args, `@${tmpFile}`];
      } else {
        finalArgs = promptViaStdin ? args : [...args, prompt];
      }

      logger.info(`${levelPrefix} Attempting LLM-based JSON extraction with ${extractionModel}...`);

      const proc = spawn(command, finalArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(configEnv || {}),
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
        cleanupTmpFile();
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
        const extracted = extractJSON(stdout, level, levelPrefix);
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
        cleanupTmpFile();
        logger.warn(`${levelPrefix} LLM extraction process error: ${error.message}`);
        settle({ success: false, error: error.message });
      });

      // Deliver prompt based on config method
      if (promptViaStdin) {
        // Handle stdin errors (e.g., EPIPE if process exits before write completes)
        proc.stdin.on('error', (err) => {
          logger.warn(`${levelPrefix} extraction stdin error: ${err.message}`);
        });

        proc.stdin.write(prompt, (err) => {
          if (err) {
            logger.warn(`${levelPrefix} Failed to write extraction prompt: ${err}`);
            proc.kill('SIGTERM');
            settle({ success: false, error: `Failed to write prompt: ${err}` });
          }
        });
        proc.stdin.end();
      } else if (promptViaFile) {
        // Prompt delivered via @file arg — close stdin so wrappers (e.g., devx) don't hang
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
 * Default timeout (ms) for a provider availability probe when no
 * per-provider `availability_timeout_seconds` is configured.
 */
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 10000;

/**
 * Convert a configured `availability_timeout_seconds` value to milliseconds.
 * Single source of truth for the "valid positive seconds" predicate shared by
 * every availability-probe timeout (AI providers, executable providers, and
 * chat providers); falls back to `defaultMs` when the value is unset,
 * non-numeric, non-finite, or <= 0.
 * @param {*} seconds - Raw config value, expected to be a number of seconds
 * @param {number} [defaultMs=DEFAULT_AVAILABILITY_TIMEOUT_MS] - Fallback in ms
 * @returns {number} Timeout in milliseconds
 */
function secondsToTimeoutMs(seconds, defaultMs = DEFAULT_AVAILABILITY_TIMEOUT_MS) {
  return (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
    ? seconds * 1000
    : defaultMs;
}

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
 * All valid tier values (canonical + aliases)
 */
const VALID_TIERS = [...TIERS, ...Object.keys(TIER_ALIASES)];

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
 * Match a model definition against a selector that may be the model's canonical
 * id OR one of its aliases. Used by config-driven selectors (`default_model`,
 * `disabled_models`, `models` overrides) so legacy config naming an alias (e.g.
 * `opus`, an alias of the canonical `opus-4.8-xhigh`) keeps working.
 *
 * Optional-chaining is intentional: a model with no `aliases` short-circuits to
 * undefined/falsy, so no Array.isArray guard is needed.
 *
 * @param {Object} model - Model definition (must have an `id`; may have `aliases`)
 * @param {string} selector - Selector to match against id or aliases
 * @returns {boolean}
 */
function modelMatches(model, selector) {
  return model.id === selector || model.aliases?.includes(selector);
}

/**
 * Resolve the default model from an array of model definitions.
 * Priority: provider-level `default_model` (preferredId) > legacy model with
 * `default:true` > first balanced tier model > first model.
 *
 * `preferredId` is the provider-level `default_model` config value. It is the
 * preferred way to pick a default; the per-model `default:true` flag is the
 * deprecated legacy mechanism, kept for backward compatibility. When
 * `preferredId` names a model that isn't present (e.g. it was disabled or
 * mistyped), resolution falls through to the legacy/automatic logic — the
 * mismatch is warned about once at config-apply time, not here.
 *
 * @param {Array<Object>} models - Array of model definitions (already filtered)
 * @param {string|null} [preferredId] - Provider-level `default_model` id
 * @returns {string|null} - Default model ID or null if no models
 */
function resolveDefaultModel(models, preferredId = null) {
  if (!models || models.length === 0) {
    return null;
  }

  // Provider-level `default_model` wins when it names an available model
  // (by canonical id or alias). Returns the canonical id either way.
  if (preferredId) {
    const preferred = models.find(m => modelMatches(m, preferredId));
    if (preferred) {
      return preferred.id;
    }
  }

  // Legacy: model explicitly marked default:true (deprecated in favor of default_model)
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
 * Create an aliased provider class that reuses an existing provider's implementation
 * but with a different ID, name, and config overrides.
 *
 * @param {string} aliasId - New provider ID (e.g., 'pi-reskin')
 * @param {typeof AIProvider} BaseClass - The base provider class to alias
 * @param {Object} aliasConfig - Config for the alias (name, models, etc.)
 * @returns {typeof AIProvider} A subclass with overridden static metadata
 */
function createAliasedProviderClass(aliasId, BaseClass, aliasConfig) {
  const processedModels = Array.isArray(aliasConfig.models) && aliasConfig.models.length > 0
    ? aliasConfig.models.map(inferModelDefaults)
    : null;

  class AliasedProvider extends BaseClass {}

  // Override static metadata so the alias has its own identity
  AliasedProvider.getProviderName = () => aliasConfig.name || aliasId;
  AliasedProvider.getProviderId = () => aliasId;
  if (processedModels) {
    AliasedProvider.getModels = () => processedModels;
    AliasedProvider.getDefaultModel = () => resolveDefaultModel(processedModels, aliasConfig.default_model || null);
  }
  if (aliasConfig.installInstructions) {
    AliasedProvider.getInstallInstructions = () => aliasConfig.installInstructions;
  }
  if (aliasConfig.defaultTimeout != null) {
    AliasedProvider.defaultTimeout = aliasConfig.defaultTimeout;
  }

  return AliasedProvider;
}

/**
 * Apply configuration overrides for all providers.
 * Called once at startup after all providers have self-registered.
 * Does not support re-application — the provider registry is intentionally
 * not cleaned between calls (aliased/executable classes persist).
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

    // Executable providers: dynamically create and register a provider class
    if (providerConfig.type === 'executable') {
      if (!providerConfig.command) {
        logger.warn(`Executable provider "${providerId}" missing required "command" field`);
        continue;
      }
      // Lazy-require to avoid circular dependency
      const { createExecutableProviderClass } = require('./executable-provider');
      const ExecClass = createExecutableProviderClass(providerId, providerConfig);
      registerProvider(providerId, ExecClass);
      const execDisabled = normalizeDisabledModels(providerId, providerConfig.disabled_models);
      const execDefault = providerConfig.default_model || null;
      validateModelSelectors(providerId, ExecClass.getModels(), null, execDisabled, execDefault);
      providerConfigOverrides.set(providerId, {
        ...providerConfig,
        models: ExecClass.getModels(),
        disabled_models: execDisabled,
        default_model: execDefault
      });
      logger.debug(`Registered executable provider: ${providerId}`);
      continue;
    }

    // Type matching a registered provider ID creates an alias of that provider
    if (providerConfig.type && providerConfig.type !== providerId && providerRegistry.has(providerConfig.type)) {
      const BaseClass = providerRegistry.get(providerConfig.type);
      const AliasClass = createAliasedProviderClass(providerId, BaseClass, providerConfig);
      registerProvider(providerId, AliasClass);

      const aliasDisabled = normalizeDisabledModels(providerId, providerConfig.disabled_models);
      const aliasDefault = providerConfig.default_model || null;
      validateModelSelectors(providerId, AliasClass.getModels(), null, aliasDisabled, aliasDefault);

      // Aliases reuse the base provider's implementation class, not its config.
      // Only universal override fields are forwarded; provider-specific fields
      // (e.g. codex args) must be explicitly set in the alias config.
      providerConfigOverrides.set(providerId, {
        command: providerConfig.command,
        installInstructions: providerConfig.installInstructions,
        extra_args: providerConfig.extra_args,
        env: providerConfig.env,
        load_skills: providerConfig.load_skills,
        app_extensions: providerConfig.app_extensions,
        availability_timeout_seconds: providerConfig.availability_timeout_seconds,
        models: AliasClass.getModels() !== BaseClass.getModels() ? AliasClass.getModels() : null,
        disabled_models: aliasDisabled,
        default_model: aliasDefault
      });
      logger.debug(`Registered aliased provider: ${providerId} (base: ${providerConfig.type})`);
      continue;
    }

    // Unknown type: warn and skip (self-referential type falls through to standard override path)
    if (providerConfig.type && providerConfig.type !== providerId) {
      logger.warn(`Provider "${providerId}" has unknown type "${providerConfig.type}" — no matching registered provider`);
      continue;
    }

    // Process models if specified - infer defaults for each
    let processedModels = null;
    if (Array.isArray(providerConfig.models) && providerConfig.models.length > 0) {
      processedModels = providerConfig.models.map(inferModelDefaults);
      logger.debug(`Configured ${processedModels.length} models for ${providerId}`);
      // Deprecation: per-model `default: true` is superseded by provider-level `default_model`.
      // Only warn when the user didn't already adopt the new field.
      if (providerConfig.default_model == null && processedModels.some(m => m.default === true)) {
        logger.warn(`Provider "${providerId}": per-model "default: true" is deprecated. Set provider-level "default_model": "<id>" instead.`);
      }
    }

    const builtInModels = providerRegistry.get(providerId)?.getModels();

    // Canonicalize alias-keyed override ids to their built-in canonical id.
    // A config entry may key a model by a short alias (e.g. `opus` for the
    // canonical `opus-4.8-xhigh`). mergeModels() already resolves aliases for the
    // display/metadata path, but the runtime path forwards this raw `models` array
    // to the provider instance, where per-model config is looked up by EXACT id
    // (e.g. `configOverrides.models.find(m => m.id === model)`). The frontend
    // submits the canonical id, so an alias-keyed entry would never match and its
    // cli_model/env/extra_args would be silently dropped. Rewriting the id here —
    // the single point where the override is stored — keeps metadata and runtime
    // execution in agreement.
    if (processedModels && builtInModels) {
      processedModels = processedModels.map(cm => {
        const builtIn = builtInModels.find(bm => modelMatches(bm, cm.id));
        return builtIn && builtIn.id !== cm.id ? { ...cm, id: builtIn.id } : cm;
      });
    }

    const disabledModels = normalizeDisabledModels(providerId, providerConfig.disabled_models);
    const defaultModel = providerConfig.default_model || null;
    validateModelSelectors(providerId, builtInModels, processedModels, disabledModels, defaultModel);

    // Store the overrides
    providerConfigOverrides.set(providerId, {
      command: providerConfig.command,
      installInstructions: providerConfig.installInstructions,
      extra_args: providerConfig.extra_args,
      env: providerConfig.env,
      load_skills: providerConfig.load_skills,
      app_extensions: providerConfig.app_extensions,
      availability_timeout_seconds: providerConfig.availability_timeout_seconds,
      models: processedModels,
      disabled_models: disabledModels,
      default_model: defaultModel
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
 * Resolve a non-executable provider id, preferring `preferredId` if it is
 * non-executable. Falls back to the first registered non-executable provider.
 * Returns null if none are available.
 * @param {string} [preferredId] - Preferred provider id
 * @returns {string|null}
 */
function resolveNonExecutableProviderId(preferredId) {
  if (preferredId) {
    const cls = getProviderClass(preferredId);
    if (cls && !cls.isExecutable) return preferredId;
  }
  for (const pid of getRegisteredProviderIds()) {
    const cls = getProviderClass(pid);
    if (cls && !cls.isExecutable) return pid;
  }
  return null;
}

/**
 * Merge config-override models with a provider's built-in models.
 * A config model whose id matches a built-in's canonical id OR one of its
 * aliases replaces that built-in in place (preserving display order). The
 * canonical built-in id is preserved as the internal source of truth, and the
 * built-in's aliases are kept unless the override supplies its own. Config
 * models that match no built-in are appended. If no config models exist,
 * returns built-ins unchanged.
 *
 * @param {Array<Object>} builtInModels - Models from ProviderClass.getModels()
 * @param {Array<Object>|undefined} configModels - Models from config overrides
 * @returns {Array<Object>} Merged model list
 */
function mergeModels(builtInModels, configModels) {
  if (!configModels || configModels.length === 0) {
    return builtInModels;
  }
  // Replace overridden built-ins in-place to preserve display order. An override
  // matched by alias (e.g. config `{ id: 'opus' }` against built-in
  // `opus-4.8-xhigh`) still replaces, but keeps the canonical built-in id.
  const matched = new Set();
  const merged = builtInModels.map(bm => {
    const override = configModels.find(cm => modelMatches(bm, cm.id));
    if (override) {
      matched.add(override);
      return { ...override, id: bm.id, aliases: override.aliases ?? bm.aliases };
    }
    return bm;
  });
  // Append config models that matched no built-in (genuinely new ids)
  for (const cm of configModels) {
    if (!matched.has(cm)) {
      merged.push(cm);
    }
  }
  return merged;
}

/**
 * Compute the effective model list for a provider: built-in models merged with
 * config-override models, then with any `disabled_models` IDs removed.
 *
 * This is the single source of truth for "which models does this provider
 * actually expose" — every call site that surfaces or selects a model should go
 * through here so a disabled model is hidden consistently (UI, default
 * resolution, instance creation).
 *
 * If `disabled_models` would remove every model, the filter is ignored (a
 * provider with zero models is unusable). Unknown/empty-list validation and
 * warnings happen once at config-apply time in {@link applyConfigOverrides};
 * this function is intentionally silent so it can run on every request.
 *
 * @param {Array<Object>} builtInModels - Models from ProviderClass.getModels()
 * @param {Object} [overrides] - Stored config overrides for the provider
 * @returns {Array<Object>} Effective model list
 */
function applyModelOverrides(builtInModels, overrides) {
  const merged = mergeModels(builtInModels, overrides?.models);
  const disabled = overrides?.disabled_models;
  if (!Array.isArray(disabled) || disabled.length === 0) {
    return merged;
  }
  // Drop a model if ANY disabled selector matches it by canonical id or alias.
  const filtered = merged.filter(m => !disabled.some(d => modelMatches(m, d)));
  // Never strip a provider down to zero models — fall back to the unfiltered set.
  return filtered.length > 0 ? filtered : merged;
}

/**
 * Normalize a `disabled_models` config value into a clean array of string IDs
 * (or null when absent/empty). Warns on malformed input.
 * @param {string} providerId - Provider ID (for log messages)
 * @param {*} raw - Raw config value
 * @returns {string[]|null}
 */
function normalizeDisabledModels(providerId, raw) {
  if (raw == null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    logger.warn(`Provider "${providerId}": "disabled_models" must be an array of model IDs; ignoring.`);
    return null;
  }
  const ids = raw.filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length !== raw.length) {
    logger.warn(`Provider "${providerId}": "disabled_models" contained non-string entries which were ignored.`);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Validate provider-level model selectors against the effective model set and
 * warn about mistakes. Never throws — bad selectors degrade gracefully at
 * resolution time (a disabled-everything list is ignored, an unknown
 * default_model falls back to automatic selection).
 * @param {string} providerId - Provider ID (for log messages)
 * @param {Array<Object>} builtInModels - Provider's built-in models
 * @param {Array<Object>|null} configModels - Processed config-override models
 * @param {string[]|null} disabledModels - Normalized disabled list
 * @param {string|null} defaultModel - Provider-level default_model id
 */
function validateModelSelectors(providerId, builtInModels, configModels, disabledModels, defaultModel) {
  const merged = mergeModels(builtInModels || [], configModels);
  // A selector is "known" if it matches some model by canonical id OR alias.
  const isKnown = (sel) => merged.some(m => modelMatches(m, sel));

  if (disabledModels) {
    for (const id of disabledModels) {
      if (!isKnown(id)) {
        logger.warn(`Provider "${providerId}": disabled_models references unknown model "${id}".`);
      }
    }
    const remaining = merged.filter(m => !disabledModels.some(d => modelMatches(m, d)));
    if (merged.length > 0 && remaining.length === 0) {
      logger.warn(`Provider "${providerId}": disabled_models removes every model; the filter will be ignored.`);
    }
  }

  if (defaultModel != null) {
    if (!isKnown(defaultModel)) {
      logger.warn(`Provider "${providerId}": default_model "${defaultModel}" is not a known model; falling back to automatic default.`);
    } else if (disabledModels && disabledModels.includes(defaultModel)) {
      logger.warn(`Provider "${providerId}": default_model "${defaultModel}" is also listed in disabled_models; falling back to automatic default.`);
    }
  }
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

    // Effective models: config merged with built-ins, minus disabled_models
    const effectiveModels = applyModelOverrides(ProviderClass.getModels(), overrides);

    // Resolve default model: provider-level default_model wins, then legacy/auto
    const defaultModel = resolveDefaultModel(effectiveModels, overrides?.default_model) || ProviderClass.getDefaultModel();

    // Normalize per-model `default` flags to agree with the resolved defaultModel.
    // Many frontend consumers derive the default via models.find(m => m.default),
    // so the payload's flags must reflect the new source of truth (default_model).
    // Produce NEW objects — never mutate the shared built-in model objects.
    const models = effectiveModels.map(m => ({ ...m, default: m.id === defaultModel }));

    // Use overridden install instructions if available
    const installInstructions = overrides?.installInstructions || ProviderClass.getInstallInstructions();

    // Build capabilities: executable providers define their own, others get defaults
    const capabilities = ProviderClass.capabilities || {
      review_levels: true,
      custom_instructions: true,
      exclude_previous: true,
      consolidation: true
    };

    providers.push({
      id,
      name: ProviderClass.getProviderName(),
      models,
      defaultModel,
      installInstructions,
      capabilities,
      isExecutable: ProviderClass.isExecutable || false,
      ...(ProviderClass.defaultTimeout != null ? { defaultTimeout: ProviderClass.defaultTimeout } : {})
    });
  }
  return providers;
}

/**
 * Create a provider instance
 * @param {string} providerId - Provider ID (e.g., 'claude', 'gemini')
 * @param {string} model - Model to use (optional, uses default if not specified)
 * @param {Object} overrides - Per-call config overrides that supersede global providerConfigOverrides (optional)
 * @returns {AIProvider}
 * @throws {Error} If provider is not registered
 */
function createProvider(providerId, model = null, overrides = {}) {
  const ProviderClass = providerRegistry.get(providerId);

  if (!ProviderClass) {
    const available = getRegisteredProviderIds().join(', ');
    throw new Error(`Unknown AI provider: ${providerId}. Available providers: ${available}`);
  }

  // Get config overrides for this provider
  const configOverrides = providerConfigOverrides.get(providerId);

  // Determine the actual model to use
  let actualModel = model;
  if (!actualModel) {
    // Resolve default from effective models (config + built-in, minus disabled).
    // Checks both sources because some providers (e.g., Pi) define built-in
    // modes with default:true that aren't in config overrides. Honors the
    // provider-level `default_model` selector.
    if (configOverrides?.models || ProviderClass.getModels().length > 0) {
      const effectiveModels = applyModelOverrides(ProviderClass.getModels(), configOverrides);
      actualModel = resolveDefaultModel(effectiveModels, configOverrides?.default_model);
    }
    // Fall back to provider's built-in default
    if (!actualModel) {
      actualModel = ProviderClass.getDefaultModel();
    }
  }

  // Create provider instance with config overrides, per-call overrides, and yolo mode
  return new ProviderClass(actualModel, { ...(configOverrides || {}), ...overrides, yolo: yoloMode });
}

/**
 * Resolve the availability-probe timeout (ms) for a provider.
 * Reads the per-provider `availability_timeout_seconds` config override
 * (in seconds, mirroring `checkout_timeout_seconds`); falls back to
 * DEFAULT_AVAILABILITY_TIMEOUT_MS when unset, non-numeric, or <= 0.
 * @param {string} providerId - Provider ID
 * @returns {number} Timeout in milliseconds
 */
function resolveAvailabilityTimeoutMs(providerId) {
  const seconds = providerConfigOverrides.get(providerId)?.availability_timeout_seconds;
  return secondsToTimeoutMs(seconds);
}

/**
 * Test availability of a provider with timeout
 * @param {string} providerId - Provider ID
 * @param {number} [timeoutMs] - Timeout in milliseconds. When omitted, resolved
 *   per-provider from `availability_timeout_seconds` (default 10 seconds).
 * @returns {Promise<{available: boolean, error?: string}>}
 */
async function testProviderAvailability(providerId, timeoutMs) {
  const effectiveTimeoutMs = timeoutMs != null ? timeoutMs : resolveAvailabilityTimeoutMs(providerId);
  try {
    const provider = createProvider(providerId);

    // Race between availability test and timeout. The provider's own probe
    // receives the same timeout so it can kill its child process on expiry;
    // this race is the only guard for providers without an internal timeout.
    // Capture the timer handle so we can clear it once the race settles —
    // otherwise a fast probe with a large configured timeout would keep the
    // Node event loop alive (and its rejection unobserved) until the timer fires.
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Provider test timed out after ${Math.round(effectiveTimeoutMs / 1000)}s`)),
        effectiveTimeoutMs
      );
    });

    try {
      const available = await Promise.race([
        provider.testAvailability(effectiveTimeoutMs),
        timeoutPromise
      ]);
      return { available };
    } finally {
      clearTimeout(timeoutId);
    }
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

/**
 * Get tier for a specific model from a provider.
 * Queries the provider's model definitions (or config overrides) to find the tier.
 * Matches against both the canonical model `id` and any `aliases` so legacy
 * model IDs (e.g. `gpt-5.4` before reasoning-effort variants were introduced)
 * still resolve their tier for historical analysis runs.
 * @param {string} providerId - Provider ID (e.g., 'claude', 'gemini')
 * @param {string} modelId - Model ID (e.g., 'sonnet', 'gemini-2.5-pro')
 * @returns {string|null} Tier name or null if provider or model not found
 */
function getTierForModel(providerId, modelId) {
  const ProviderClass = providerRegistry.get(providerId);
  if (!ProviderClass) {
    return null;
  }

  // Merge config models with built-in models
  const overrides = providerConfigOverrides.get(providerId);
  const models = mergeModels(ProviderClass.getModels(), overrides?.models);

  const model = models.find(m => modelMatches(m, modelId));
  return model?.tier || null;
}

module.exports = {
  AIProvider,
  MODEL_TIERS,
  quoteShellArgs,
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
  // Config override support
  applyConfigOverrides,
  createAliasedProviderClass,
  getProviderConfigOverrides,
  inferModelDefaults,
  resolveDefaultModel,
  modelMatches,
  mergeModels,
  applyModelOverrides,
  normalizeDisabledModels,
  prettifyModelId,
  getTierForModel
};
