// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ACP (Agent Client Protocol) AI Provider
 *
 * Generic provider that communicates with any ACP-compatible agent CLI.
 * Uses the ACP SDK to spawn, handshake, prompt, and collect results.
 * Designed to be instantiated multiple times via createAcpProviderClass()
 * for each ACP-based entry in the user's providers config.
 */

const { spawn } = require('child_process');
const { Writable, Readable } = require('stream');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { truncateSnippet } = require('./stream-parser');
const { AIProvider, inferModelDefaults, resolveDefaultModel, prettifyModelId, quoteShellArgs } = require('./provider');
const { version: pkgVersion } = require('../../package.json');

// Lazy-load the ESM-only ACP SDK via dynamic import (cached after first call)
let _acpModule = null;
async function loadAcp() {
  if (!_acpModule) {
    _acpModule = await import('@agentclientprotocol/sdk');
  }
  return _acpModule;
}

// Default dependencies (overridable for testing via configOverrides._deps)
const defaults = {
  spawn,
  acp: null, // lazy-loaded via loadAcp(); tests inject via _deps
  Writable,
  Readable,
};

/**
 * Kill a child process gracefully: SIGTERM, then SIGKILL after 3 seconds.
 * @param {ChildProcess} proc - The process to kill
 * @returns {Promise<void>}
 */
function killProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) { resolve(); return; }
    const killTimeout = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 3000);
    proc.once('close', () => { clearTimeout(killTimeout); resolve(); });
    proc.kill('SIGTERM');
  });
}

/**
 * Base class for ACP-based providers.
 * Not registered directly — createAcpProviderClass() produces subclasses
 * that are registered dynamically in provider.js applyConfigOverrides.
 */
class AcpProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier (or 'default' to skip setSessionModel)
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - CLI command to spawn
   * @param {string[]} configOverrides.args - CLI arguments (default: ['--acp', '--stdio'])
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object} configOverrides._deps - Dependency injection for testing
   */
  constructor(model = 'default', configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > provider ID
    const envVarName = `PAIR_REVIEW_${this.constructor.getProviderId().toUpperCase().replace(/-/g, '_')}_CMD`;
    const envCmd = process.env[envVarName];
    const configCmd = configOverrides.command;
    this.command = envCmd || configCmd || this.constructor.getProviderId();
    this.args = configOverrides.args || ['--acp', '--stdio'];
    this.extraEnv = { ...(configOverrides.env || {}) };
    this.useShell = this.command.includes(' ');
    this.configOverrides = configOverrides;

    this._deps = { ...defaults, ...(configOverrides._deps || {}) };
  }

  /**
   * Execute a prompt via the ACP protocol lifecycle.
   *
   * Spawns the agent, performs ACP handshake, creates a session,
   * optionally sets the model, sends the prompt, accumulates the
   * response, and parses JSON from the output.
   *
   * @param {string} prompt - The prompt to send
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} Parsed JSON response or { raw, parsed: false }
   */
  async execute(prompt, options = {}) {
    const {
      cwd = process.cwd(),
      timeout = 300000,
      level = 'unknown',
      analysisId,
      registerProcess,
      onStreamEvent,
      logPrefix
    } = options;

    const levelPrefix = logPrefix || `[Level ${level}]`;
    const providerId = this.constructor.getProviderId();
    const deps = this._deps;

    logger.info(`${levelPrefix} Executing ACP provider "${providerId}"...`);
    logger.info(`${levelPrefix} Prompt length: ${prompt.length} bytes`);

    // Lazy-load ACP SDK if not injected
    if (!deps.acp) {
      deps.acp = await loadAcp();
    }

    let proc = null;
    let timeoutId = null;

    try {
      // 1. Spawn the agent process
      const command = this.command;
      const args = [...this.args];
      const useShell = this.useShell;

      const spawnCmd = useShell ? `${command} ${quoteShellArgs(args).join(' ')}` : command;
      const spawnArgs = useShell ? [] : args;

      proc = deps.spawn(spawnCmd, spawnArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv },
        shell: useShell,
      });

      proc.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} ACP CLI not found: ${this.command}`);
        } else {
          logger.error(`${levelPrefix} ACP process error: ${error.message}`);
        }
      });

      const pid = proc.pid;
      logger.info(`${levelPrefix} Spawned ACP process: PID ${pid}`);

      // Register for cancellation tracking
      if (analysisId && registerProcess) {
        registerProcess(analysisId, proc);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      // Collect stderr for diagnostics
      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle stdin errors (e.g., EPIPE if process dies)
      proc.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // 2. Set up ACP connection
      const stream = deps.acp.ndJsonStream(
        deps.Writable.toWeb(proc.stdin),
        deps.Readable.toWeb(proc.stdout)
      );

      // Accumulate text from agent_message_chunk updates
      let accumulatedText = '';

      const clientHandler = {
        sessionUpdate(params) {
          const update = params.update;
          if (!update) return;

          const type = update.sessionUpdate;

          if (type === 'agent_message_chunk') {
            const content = update.content;
            if (content?.type === 'text' && content.text) {
              accumulatedText += content.text;
              if (onStreamEvent) {
                onStreamEvent({
                  type: 'assistant_text',
                  text: truncateSnippet(content.text),
                  timestamp: Date.now(),
                });
              }
            }
          } else if (type === 'tool_call') {
            if (onStreamEvent) {
              onStreamEvent({
                type: 'tool_use',
                text: truncateSnippet(update.title || 'Tool call'),
                timestamp: Date.now(),
              });
            }
          }
        },
        requestPermission(params) {
          // Auto-approve: prefer allow_once > allow_always > cancel
          const permOptions = params.options || [];
          const allowOnce = permOptions.find((o) => o.kind === 'allow_once');
          if (allowOnce) {
            logger.debug(`${levelPrefix} Auto-approving permission (allow_once): ${allowOnce.name || allowOnce.optionId}`);
            return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
          }
          const allowAlways = permOptions.find((o) => o.kind === 'allow_always');
          if (allowAlways) {
            logger.debug(`${levelPrefix} Auto-approving permission (allow_always): ${allowAlways.name || allowAlways.optionId}`);
            return { outcome: { outcome: 'selected', optionId: allowAlways.optionId } };
          }
          logger.warn(`${levelPrefix} No allow option found, cancelling permission request`);
          return { outcome: { outcome: 'cancelled' } };
        },
      };

      const connection = new deps.acp.ClientSideConnection(
        (_agent) => clientHandler,
        stream
      );

      // 3. ACP handshake
      await connection.initialize({
        protocolVersion: deps.acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'pair-review', version: pkgVersion },
      });

      // 4. Create session
      const { sessionId } = await connection.newSession({ cwd });
      logger.info(`${levelPrefix} ACP session created: ${sessionId}`);

      // 5. Optionally set the model (skip for 'default')
      if (this.model !== 'default' && connection.unstable_setSessionModel) {
        try {
          await connection.unstable_setSessionModel({
            sessionId,
            modelId: this.model,
          });
          logger.info(`${levelPrefix} Model set: ${this.model}`);
        } catch (err) {
          logger.warn(`${levelPrefix} Failed to set model (agent may not support it): ${err.message}`);
        }
      }

      // 6. Send prompt with timeout
      const promptPromise = connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${levelPrefix} ACP provider timed out after ${timeout}ms`));
        }, timeout);
      });

      const raceResult = Promise.race([promptPromise, timeoutPromise]);
      promptPromise.catch(() => {}); // swallow rejection if timeout wins
      await raceResult;

      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

      logger.info(`${levelPrefix} ACP prompt completed, accumulated ${accumulatedText.length} chars`);

      // Check for cancellation
      if (analysisId && isAnalysisCancelled(analysisId)) {
        throw new CancellationError(`${levelPrefix} Analysis cancelled by user`);
      }

      if (stderr.trim()) {
        logger.warn(`${levelPrefix} ACP stderr: ${stderr}`);
      }

      // 7. Parse JSON from accumulated text
      const extracted = extractJSON(accumulatedText, level);
      if (extracted.success) {
        logger.success(`${levelPrefix} Successfully parsed JSON response`);
        return extracted.data;
      }

      // Regex extraction failed — try LLM-based extraction as fallback
      // TODO: ACP lifecycle overhead makes it impractical for the lightweight extraction fallback.
      // getExtractionConfig() returns null, so extractJSONWithLLM() will always return { success: false }.
      // A future implementation could send a second ACP prompt asking the agent to fix its JSON.
      logger.warn(`${levelPrefix} Regex extraction failed: ${extracted.error}`);
      logger.info(`${levelPrefix} Raw response length: ${accumulatedText.length} characters`);
      logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback (no-op for ACP providers)...`);

      try {
        const llmExtracted = await this.extractJSONWithLLM(accumulatedText, {
          level,
          analysisId,
          registerProcess,
          logPrefix: levelPrefix
        });
        if (llmExtracted.success) {
          logger.success(`${levelPrefix} LLM extraction fallback succeeded`);
          return llmExtracted.data;
        }
        logger.warn(`${levelPrefix} LLM extraction fallback also failed: ${llmExtracted.error}`);
        logger.info(`${levelPrefix} Raw response preview: ${accumulatedText.substring(0, 500)}...`);
        return { raw: accumulatedText, parsed: false };
      } catch (llmError) {
        logger.warn(`${levelPrefix} LLM extraction fallback error: ${llmError.message}`);
        return { raw: accumulatedText, parsed: false };
      }
    } catch (err) {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

      // Re-throw cancellation errors as-is
      if (err instanceof CancellationError) {
        throw err;
      }

      // Check for cancellation via signal codes
      if (analysisId && isAnalysisCancelled(analysisId)) {
        throw new CancellationError(`${levelPrefix} Analysis cancelled by user`);
      }

      logger.error(`${levelPrefix} ACP provider error: ${err.message}`);
      throw err;
    } finally {
      if (timeoutId) { clearTimeout(timeoutId); }
      await killProcess(proc);
    }
  }

  /**
   * Get CLI configuration for LLM extraction.
   * Returns null — ACP lifecycle is too heavy for extraction.
   * @returns {null}
   */
  getExtractionConfig() {
    return null;
  }

  /**
   * Test if the ACP agent CLI is available by running --version.
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      const deps = this._deps;
      const useShell = this.useShell;
      const command = useShell ? `${this.command} --version` : this.command;
      const args = useShell ? [] : ['--version'];

      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`ACP availability check (${this.constructor.getProviderId()}): ${fullCmd}`);

      const proc = deps.spawn(command, args, {
        env: { ...process.env, ...this.extraEnv },
        shell: useShell,
      });

      let stdout = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGTERM');
        logger.warn(`ACP availability check timed out for ${this.constructor.getProviderId()}`);
        resolve(false);
      }, 10000);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          logger.info(`ACP CLI available (${this.constructor.getProviderId()}): ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn(`ACP CLI not available for ${this.constructor.getProviderId()} (exit code ${code})`);
          resolve(false);
        }
      });

      proc.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        logger.warn(`ACP CLI not available for ${this.constructor.getProviderId()}: ${error.message}`);
        resolve(false);
      });
    });
  }
}

/**
 * Factory function that creates a unique AcpProvider subclass for each
 * ACP-based entry in the user's providers config.
 *
 * The provider registry relies on static methods called on the class.
 * A single generic AcpProvider can't serve multiple configs, so the factory
 * stamps out a subclass with the correct static metadata per config entry.
 *
 * @param {string} id - Provider ID (e.g., 'my-agent')
 * @param {Object} providerConfig - Provider configuration from config.json
 * @returns {typeof AcpProvider} A unique subclass of AcpProvider
 */
function createAcpProviderClass(id, providerConfig) {
  const models = providerConfig.models?.length > 0
    ? providerConfig.models.map(inferModelDefaults)
    : [{ id: 'default', name: 'Default', tier: 'balanced', default: true, badge: 'Recommended', badgeClass: 'badge-recommended' }];

  const name = providerConfig.name || prettifyModelId(id);
  const defaultModel = resolveDefaultModel(models);
  const installInstructions = providerConfig.installInstructions
    || `Install ${name} and ensure it supports ACP (--acp --stdio)`;

  class DynamicAcpProvider extends AcpProvider {
    static getProviderId() { return id; }
    static getProviderName() { return name; }
    static getModels() { return models; }
    static getDefaultModel() { return defaultModel; }
    static getInstallInstructions() { return installInstructions; }
  }

  return DynamicAcpProvider;
}

module.exports = { AcpProvider, createAcpProviderClass };
