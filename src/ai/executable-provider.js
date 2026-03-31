// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Executable AI Provider
 *
 * A dynamic provider type that runs external CLI tools
 * as code review providers. The tool's output is mapped to pair-review's suggestion
 * schema via an LLM.
 *
 * Unlike other providers, this is a factory that returns a provider class per config
 * entry. Registration happens in provider.js during applyConfigOverrides(), not at
 * module load time.
 */

const providerModule = require('./provider');
const { AIProvider, resolveDefaultModel, inferModelDefaults } = providerModule;
const { spawn } = require('child_process');
const { glob } = require('glob');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const jsonExtractor = require('../utils/json-extractor');
const configModule = require('../config');

/**
 * Convert a snake_case string to camelCase
 * @param {string} str - snake_case string
 * @returns {string} camelCase string
 */
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Build the mapping prompt for translating tool output to pair-review schema.
 * Kept here rather than a separate file since the template is short and
 * tightly coupled to the executable provider logic.
 *
 * @param {string} mappingInstructions - Tool-specific mapping instructions
 * @param {string} rawOutput - Raw JSON output from the external tool
 * @returns {string} Complete mapping prompt
 */
function buildMappingPrompt(mappingInstructions, rawOutput) {
  return `You are mapping the output of an external code review tool to a standardized JSON format.

Map the tool's output to this exact JSON schema:
{
  "reasoning": ["step 1...", "step 2..."],
  "suggestions": [{
    "file": "path/to/file",
    "line_start": 42,
    "line_end": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|security|performance|design|suggestion|code-style|praise",
    "severity": "critical|medium|minor",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "Fix guidance (omit for praise)",
    "confidence": 0.85,
    "is_file_level": false
  }],
  "summary": "Overall assessment"
}

Rules:
- Include a "reasoning" array with step-by-step reasoning about how you mapped the tool output
- Map each review finding to one suggestion object
- Use "NEW" for old_or_new (external tools review the new version)
- Preserve severity if the tool provides it
- Set is_file_level: true and line_start/line_end to null for findings without line numbers
- Output ONLY valid JSON, no markdown or explanation

${mappingInstructions}

--- RAW TOOL OUTPUT ---
${rawOutput}`;
}

/**
 * Create a dynamic AIProvider subclass for an executable tool.
 *
 * @param {string} id - Provider ID (used in config and registration)
 * @param {Object} config - Provider configuration from config.json
 * @param {string} config.command - CLI command to run
 * @param {string[]} config.args - Base CLI arguments
 * @param {string} config.name - Display name
 * @param {Object} config.capabilities - Provider capabilities overrides
 * @param {boolean} config.capabilities.review_levels - Whether the tool supports L1/L2/L3 analysis
 * @param {boolean} config.capabilities.custom_instructions - Whether the tool supports custom instructions
 * @param {boolean} config.capabilities.exclude_previous - Whether the tool supports excluding previous findings
 * @param {boolean} config.capabilities.consolidation - Whether the tool can be used for consolidation
 * @param {Object} config.context_args - Maps context keys to CLI flags
 * @param {string} config.output_glob - Glob pattern to find result file
 * @param {string} config.mapping_instructions - Tool-specific mapping instructions for LLM
 * @param {Object} config.env - Extra environment variables
 * @param {string} config.installInstructions - Installation instructions
 * @param {Object[]} config.models - Model definitions
 * @returns {typeof AIProvider} A provider class for this executable tool
 */
function createExecutableProviderClass(id, config) {
  // Process models from config, inferring defaults for each
  const models = (config.models || [{ id: 'default', name: 'Default', tier: 'thorough', default: true }])
    .map(m => inferModelDefaults(m));

  class ExecProvider extends AIProvider {
    /**
     * @param {string} model - Model identifier (may be unused for single-model tools)
     * @param {Object} configOverrides - Config overrides from providers config
     */
    constructor(model = 'default', configOverrides = {}) {
      super(model);

      // Command precedence: ENV > config > id
      const envVar = `PAIR_REVIEW_${id.toUpperCase().replace(/-/g, '_')}_CMD`;
      const envCmd = process.env[envVar];
      const configCmd = config.command;
      this.execCommand = envCmd || configCmd || id;

      // For multi-word commands, use shell mode
      this.useShell = this.execCommand.includes(' ');

      // Resolve model-level config from the models array
      const modelConfig = models.find(m => m.id === model) || {};
      // cli_model: explicit string overrides model id; "" or null suppresses model; undefined falls back to id
      this.resolvedModel = modelConfig.cli_model !== undefined ? (modelConfig.cli_model || null) : model;
      this.modelExtraArgs = modelConfig.extra_args || [];

      // Store config fields
      this.baseArgs = config.args || [];
      this.providerExtraArgs = [
        ...(config.extra_args || []),
        ...(configOverrides.extra_args || [])
      ];
      this.contextArgs = config.context_args || {};
      this.diffArgs = config.diff_args || [];
      this.outputGlob = config.output_glob || '**/results.json';
      this.mappingInstructions = config.mapping_instructions || '';
      this.timeout = config.timeout || 600000; // Default 10 minutes
      this.availabilityCommand = config.availability_command || 'true';
      this.extraEnv = {
        ...(config.env || {}),
        ...(configOverrides.env || {}),
        ...(modelConfig.env || {})
      };
    }

    /**
     * Build CLI arguments from executable context.
     * Maps context keys (camelCase in code) to CLI flags via context_args config (snake_case keys).
     *
     * @param {Object} executableContext - Context from the analysis runner
     * @returns {string[]} Complete args array
     * @private
     */
    _buildArgs(executableContext) {
      const args = [...this.baseArgs, ...this.providerExtraArgs, ...this.modelExtraArgs];

      for (const [configKey, flag] of Object.entries(this.contextArgs)) {
        // Config keys are snake_case, context keys are camelCase
        const contextKey = snakeToCamel(configKey);
        const value = executableContext[contextKey];
        if (value != null) {
          args.push(flag, String(value));
        }
      }

      return args;
    }

    /**
     * Execute the external CLI tool.
     *
     * @param {string} prompt - Unused (tool has its own prompts)
     * @param {Object} options - Execution options
     * @param {Object} options.executableContext - Context: { title, description, outputDir, cwd }
     * @param {string} options.analysisId - Analysis ID for cancellation tracking
     * @param {Function} options.registerProcess - Register child process for cancellation
     * @param {Function} options.onStreamEvent - Callback for progress updates
     * @param {number} options.timeout - Timeout in ms (default 300000)
     * @returns {Promise<Object>} { success: true, data: { suggestions, summary } }
     */
    async execute(prompt, options = {}) {
      const {
        executableContext = {},
        analysisId,
        registerProcess,
        onStreamEvent,
        timeout = 300000
      } = options;

      const outputDir = executableContext.outputDir;
      const cwd = executableContext.cwd || process.cwd();

      // Build CLI args from context
      const cliArgs = this._buildArgs(executableContext);

      logger.info(`[${id}] Executing external tool: ${this.execCommand} ${cliArgs.join(' ')}`);

      // Spawn the process
      const command = this.useShell
        ? `${this.execCommand} ${cliArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`
        : this.execCommand;
      const spawnArgs = this.useShell ? [] : cliArgs;

      const child = spawn(command, spawnArgs, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv
        },
        shell: this.useShell
      });

      const pid = child.pid;
      logger.info(`[${id}] Spawned process: PID ${pid}`);

      // Register for cancellation tracking.
      // Wrap the child's kill method so we can detect when the process is
      // killed externally (e.g., via shared.killProcesses on user cancel).
      let cancelled = false;
      if (analysisId && registerProcess) {
        const originalKill = child.kill.bind(child);
        child.kill = (...args) => {
          cancelled = true;
          return originalKill(...args);
        };
        registerProcess(analysisId, child);
        logger.info(`[${id}] Registered process ${pid} for analysis ${analysisId}`);
      }

      // Emit progress event
      if (onStreamEvent) {
        onStreamEvent({
          type: 'assistant_text',
          text: `Running external tool: ${config.name || id}...`,
          timestamp: Date.now()
        });
      }

      // Collect stdout/stderr and wait for completion
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let timeoutId = null;
        let timedOut = false;
        let settled = false;

        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          if (timeoutId) clearTimeout(timeoutId);
          fn(value);
        };

        // Set timeout — kills process but lets the close handler check for output
        if (timeout) {
          timeoutId = setTimeout(() => {
            timedOut = true;
            logger.error(`[${id}] Process ${pid} timed out after ${timeout}ms`);
            if (stdout.trim()) {
              logger.warn(`[${id}] stdout before timeout: ${stdout.trim().slice(0, 2000)}`);
            }
            if (stderr.trim()) {
              logger.warn(`[${id}] stderr before timeout: ${stderr.trim().slice(0, 2000)}`);
            }
            child.kill('SIGTERM');
          }, timeout);
        }

        child.stdout.on('data', (data) => {
          const chunk = data.toString();
          stdout += chunk;
          // Stream each line to debug output for live visibility
          for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
              logger.streamDebug(`[${id}] ${trimmed}`);
              if (onStreamEvent) {
                onStreamEvent({
                  type: 'assistant_text',
                  text: trimmed.slice(0, 200),
                  timestamp: Date.now()
                });
              }
            }
          }
        });

        child.stderr.on('data', (data) => {
          const chunk = data.toString();
          stderr += chunk;
          for (const line of chunk.split('\n')) {
            if (line.trim()) logger.streamDebug(`[${id}] ${line}`);
          }
        });

        child.on('close', async (code) => {
          if (settled) return;

          if (stderr.trim()) {
            if (code !== 0) {
              logger.error(`[${id}] stderr (exit code ${code}): ${stderr}`);
            } else {
              logger.warn(`[${id}] stderr (success): ${stderr}`);
            }
          }

          if (code !== 0) {
            logger.warn(`[${id}] External tool exited with code ${code}`);
            if (stdout.trim()) {
              logger.warn(`[${id}] stdout: ${stdout.trim().slice(0, 2000)}`);
            }
          } else {
            logger.info(`[${id}] External tool completed successfully`);
          }

          try {
            // Find the result file — check even on non-zero exit code,
            // since some tools exit non-zero but still produce valid output
            if (!outputDir) {
              settle(reject, new Error(`[${id}] No output directory specified in executableContext`));
              return;
            }

            const matches = await glob(this.outputGlob, { cwd: outputDir });
            if (!matches || matches.length === 0) {
              if (cancelled && !timedOut) {
                const cancelError = new Error(`[${id}] Analysis cancelled by user`);
                cancelError.isCancellation = true;
                settle(reject, cancelError);
              } else if (timedOut) {
                settle(reject, new Error(`[${id}] External tool timed out after ${timeout}ms and produced no output`));
              } else if (code !== 0) {
                const output = (stderr || stdout || '(no output)').trim().slice(0, 2000);
                settle(reject, new Error(`[${id}] External tool exited with code ${code} and produced no output: ${output}`));
              } else {
                settle(reject, new Error(`[${id}] No result file matching ${this.outputGlob} found in ${outputDir}`));
              }
              return;
            }

            if (timedOut) {
              logger.warn(`[${id}] Tool timed out but produced output — treating as success`);
            } else if (code !== 0) {
              logger.warn(`[${id}] Tool exited with code ${code} but produced output — treating as success`);
            }

            const resultPath = path.join(outputDir, matches[0]);
            logger.info(`[${id}] Reading result file: ${resultPath}`);
            const rawJson = await fs.readFile(resultPath, 'utf-8');
            logger.info(`[${id}] Result file: ${rawJson.length} bytes`);

            // Map the output to pair-review's schema
            if (onStreamEvent) {
              onStreamEvent({
                type: 'assistant_text',
                text: 'Mapping tool output to suggestion format...',
                timestamp: Date.now()
              });
            }
            const mapped = await this.mapOutputToSchema(rawJson);
            logger.info(`[${id}] Mapped ${mapped.suggestions?.length || 0} suggestions`);

            settle(resolve, {
              success: true,
              data: {
                suggestions: mapped.suggestions,
                summary: mapped.summary
              }
            });
          } catch (err) {
            logger.error(`[${id}] Post-processing failed: ${err.message}`);
            settle(reject, err);
          }
        });

        child.on('error', (error) => {
          if (error.code === 'ENOENT') {
            logger.error(`[${id}] Command not found: ${this.execCommand}`);
            settle(reject, new Error(`[${id}] Command not found: ${this.execCommand}. ${config.installInstructions || `Install ${id}`}`));
          } else {
            logger.error(`[${id}] Process error: ${error}`);
            settle(reject, error);
          }
        });
      });
    }

    /**
     * Map raw tool output to pair-review's suggestion schema using an LLM.
     *
     * @param {string} rawOutput - Raw JSON string from the external tool
     * @returns {Promise<{suggestions: Array, summary: string}>}
     */
    async mapOutputToSchema(rawOutput) {
      const mappingPrompt = buildMappingPrompt(this.mappingInstructions, rawOutput);

      // Find a mapping provider: prefer the user's configured default, fall back to
      // any registered non-executable provider. Never hardcode a specific provider.
      let mappingProviderId = null;

      // Try the user's configured default provider first
      try {
        const config = await configModule.loadConfig();
        const defaultId = configModule.getDefaultProvider(config);
        const defaultClass = providerModule.getProviderClass(defaultId);
        if (defaultClass && !defaultClass.isExecutable) {
          mappingProviderId = defaultId;
        }
      } catch {
        // Config or provider not available — fall through to fallback
      }

      if (!mappingProviderId) {
        // Fall back to any registered non-executable provider
        for (const pid of providerModule.getRegisteredProviderIds()) {
          const pClass = providerModule.getProviderClass(pid);
          if (pClass && !pClass.isExecutable) {
            mappingProviderId = pid;
            break;
          }
        }
      }

      if (!mappingProviderId) {
        throw new Error(`[${id}] No mapping provider available. Need at least one non-executable provider (e.g., claude) registered.`);
      }

      logger.info(`[${id}] Mapping output using provider: ${mappingProviderId}`);
      const provider = providerModule.createProvider(mappingProviderId);
      const result = await provider.execute(mappingPrompt, {
        cwd: process.cwd(),
        timeout: 60000,
        level: 'mapping'
      });

      // Try to extract suggestions from the result
      if (result && result.suggestions) {
        return { suggestions: result.suggestions, summary: result.summary || '' };
      }

      // If result has a data property (from structured output)
      if (result && result.data) {
        const data = result.data;
        if (data.suggestions) {
          return { suggestions: data.suggestions, summary: data.summary || '' };
        }
      }

      // If result has raw text, try to extract JSON from it
      if (result && result.raw) {
        const extracted = jsonExtractor.extractJSON(result.raw, 'mapping');
        if (extracted.success && extracted.data) {
          return {
            suggestions: extracted.data.suggestions || [],
            summary: extracted.data.summary || ''
          };
        }
      }

      // Last resort: accept only if the result actually has a suggestions array
      if (result && typeof result === 'object' && Array.isArray(result.suggestions)) {
        return { suggestions: result.suggestions, summary: result.summary || '' };
      }

      throw new Error(`[${id}] Failed to map tool output to suggestion schema`);
    }

    /**
     * Test if the external tool is available.
     * Runs the configured availability_command (defaults to 'true', i.e. always available).
     *
     * @returns {Promise<boolean>}
     */
    async testAvailability() {
      return new Promise((resolve) => {
        const command = this.availabilityCommand;
        logger.debug(`${id} availability check: ${command}`);

        const child = spawn(command, [], {
          env: { ...process.env, ...this.extraEnv },
          shell: true
        });

        let settled = false;

        const availabilityTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          logger.warn(`${id} availability check timed out after 10s`);
          try { child.kill(); } catch { /* ignore */ }
          resolve(false);
        }, 10000);

        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(availabilityTimeout);
          if (code === 0) {
            logger.info(`${id} tool available`);
            resolve(true);
          } else {
            logger.warn(`${id} tool not available (exit code ${code})`);
            resolve(false);
          }
        });

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(availabilityTimeout);
          logger.warn(`${id} tool not available: ${error.message}`);
          resolve(false);
        });
      });
    }
  }

  // Static methods and flags on the class
  ExecProvider.getProviderName = () => config.name || id;
  ExecProvider.getProviderId = () => id;
  ExecProvider.getModels = () => models;
  ExecProvider.getDefaultModel = () => resolveDefaultModel(models) || models[0]?.id;
  ExecProvider.getInstallInstructions = () => config.installInstructions || `Install ${id}`;

  // Flags for the system
  ExecProvider.isExecutable = true;
  const caps = config.capabilities || {};
  ExecProvider.capabilities = {
    review_levels: caps.review_levels !== undefined ? caps.review_levels : false,
    custom_instructions: caps.custom_instructions !== undefined ? caps.custom_instructions : false,
    exclude_previous: caps.exclude_previous !== undefined ? caps.exclude_previous : false,
    consolidation: caps.consolidation !== undefined ? caps.consolidation : false
  };

  return ExecProvider;
}

module.exports = { createExecutableProviderClass };
