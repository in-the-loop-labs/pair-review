// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * OpenCode AI Provider
 *
 * Implements the AI provider interface for OpenCode CLI.
 * Uses the `opencode run` command for non-interactive execution.
 *
 * OpenCode outputs JSONL with 'text' parts containing the response.
 *
 * NOTE: OpenCode has no built-in models configured. Models must be
 * specified via config.providers.opencode.models in ~/.pair-review/config.json
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * OpenCode model definitions
 *
 * No built-in models - must be configured via config.json
 * Example config:
 *   "providers": {
 *     "opencode": {
 *       "models": [
 *         { "id": "anthropic/claude-sonnet-4", "tier": "balanced", "default": true }
 *       ]
 *     }
 *   }
 */
const OPENCODE_MODELS = [];

class OpenCodeProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier (e.g., 'anthropic/claude-sonnet-4')
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model, configOverrides = {}) {
    // OpenCode has no built-in default model - must be configured
    if (!model) {
      throw new Error(
        'OpenCode requires a model to be configured. ' +
        'Add models to providers.opencode.models in ~/.pair-review/config.json. ' +
        'See config.example.json for examples.'
      );
    }

    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_OPENCODE_CMD;
    const configCmd = configOverrides.command;
    const opencodeCmd = envCmd || configCmd || 'opencode';

    // For multi-word commands, use shell mode
    this.useShell = opencodeCmd.includes(' ');

    // SECURITY: OpenCode runs in a worktree with prompt engineering for read-only ops
    // Similar to Gemini's security model - relies on:
    // 1. Prompt engineering: Analysis prompts instruct AI to only read, never modify
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    //
    // opencode run --model <model> --format json <prompt>
    // The prompt is passed as the final positional argument

    // Build args: base args + provider extra_args + model extra_args
    const baseArgs = ['run', '--model', model, '--format', 'json'];
    const providerArgs = configOverrides.extra_args || [];
    const modelConfig = configOverrides.models?.find(m => m.id === model);
    const modelArgs = modelConfig?.extra_args || [];

    // Merge env: provider env + model env
    this.extraEnv = {
      ...(configOverrides.env || {}),
      ...(modelConfig?.env || {})
    };

    // Store base command and args (prompt added in execute)
    this.opencodeCmd = opencodeCmd;
    this.baseArgs = [...baseArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Execute OpenCode CLI with a prompt
   * @param {string} prompt - The prompt to send to OpenCode
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing OpenCode CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      // Build the command with prompt as final argument
      let fullCommand;
      let fullArgs;

      if (this.useShell) {
        // Escape the prompt for shell using $'...' syntax which handles both
        // single quotes and backslash sequences safely
        // 1. Escape backslashes first (\ -> \\)
        // 2. Escape single quotes (' -> \')
        const escapedPrompt = prompt
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'");
        fullCommand = `${this.opencodeCmd} ${this.baseArgs.join(' ')} $'${escapedPrompt}'`;
        fullArgs = [];
      } else {
        fullCommand = this.opencodeCmd;
        fullArgs = [...this.baseArgs, prompt];
      }

      const opencode = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = opencode.pid;
      logger.info(`${levelPrefix} Spawned OpenCode CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, opencode);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let settled = false;  // Guard against multiple resolve/reject calls

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        fn(value);
      };

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          opencode.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} OpenCode CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout
      opencode.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      opencode.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      opencode.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} OpenCode CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} OpenCode CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} OpenCode CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} OpenCode CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} OpenCode CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Parse the OpenCode JSONL response
        const parsed = this.parseOpenCodeResponse(stdout, level);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          settle(resolve, parsed.data);
        } else {
          logger.warn(`${levelPrefix} Failed to extract JSON: ${parsed.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
          settle(resolve, { raw: stdout, parsed: false });
        }
      });

      // Handle errors
      opencode.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} OpenCode CLI not found. Please ensure OpenCode CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} OpenCode CLI not found. ${OpenCodeProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} OpenCode process error: ${error}`);
          settle(reject, error);
        }
      });
    });
  }

  /**
   * Parse OpenCode CLI JSONL response
   * OpenCode with --format json outputs JSONL with parts containing type: "text"
   *
   * @param {string} stdout - Raw stdout from OpenCode CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseOpenCodeResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      let textContent = '';

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Look for text parts in the response
          // OpenCode format: { parts: [{ type: "text", text: "..." }] }
          if (event.parts && Array.isArray(event.parts)) {
            for (const part of event.parts) {
              if (part.type === 'text' && part.text) {
                textContent += part.text;
              }
            }
          }

          // Also handle direct text content
          if (event.type === 'text' && event.text) {
            textContent += event.text;
          }

          // Handle content array format
          if (event.content && Array.isArray(event.content)) {
            for (const item of event.content) {
              if (item.type === 'text' && item.text) {
                textContent += item.text;
              }
            }
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      if (textContent) {
        // Try to extract JSON from the accumulated text content
        const extracted = extractJSON(textContent, level);
        if (extracted.success) {
          return extracted;
        }

        // If no JSON found, return the raw text
        logger.warn(`${levelPrefix} Text content is not JSON, treating as raw text`);
        return { success: false, error: 'Text content is not valid JSON' };
      }

      // No text content found, try extracting JSON directly from stdout
      const extracted = extractJSON(stdout, level);
      return extracted;

    } catch (parseError) {
      // stdout might not be valid JSONL at all, try extracting JSON from it
      const extracted = extractJSON(stdout, level);
      if (extracted.success) {
        return extracted;
      }

      return { success: false, error: `JSONL parse error: ${parseError.message}` };
    }
  }

  /**
   * Test if OpenCode CLI is available
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.opencodeCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.opencodeCmd} --version` : this.opencodeCmd;
      const args = useShell ? [] : ['--version'];

      const opencode = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      opencode.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      opencode.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          logger.info(`OpenCode CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('OpenCode CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      opencode.on('error', (error) => {
        if (settled) return;
        settled = true;
        logger.warn(`OpenCode CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'OpenCode';
  }

  static getProviderId() {
    return 'opencode';
  }

  static getModels() {
    return OPENCODE_MODELS;
  }

  static getDefaultModel() {
    // No built-in default - must be configured via config.json
    return null;
  }

  static getInstallInstructions() {
    return 'Install OpenCode: curl -fsSL https://opencode.ai/install | bash\n' +
           'Or visit: https://opencode.ai';
  }
}

// Register this provider
registerProvider('opencode', OpenCodeProvider);

module.exports = OpenCodeProvider;
