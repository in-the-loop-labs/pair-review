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

    // Store config overrides for getExtractionConfig to use
    this.configOverrides = configOverrides;
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
      logger.info(`${levelPrefix} Writing prompt via stdin: ${prompt.length} bytes`);

      // Use stdin for prompt instead of CLI argument (avoids shell escaping issues)
      // OpenCode reads from stdin when no positional message arguments are provided
      let fullCommand;
      let fullArgs;

      if (this.useShell) {
        fullCommand = `${this.opencodeCmd} ${this.baseArgs.join(' ')}`;
        fullArgs = [];
      } else {
        fullCommand = this.opencodeCmd;
        fullArgs = [...this.baseArgs];
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
      let lineBuffer = '';  // Buffer for incomplete JSONL lines
      let lineCount = 0;    // Count of JSONL lines received

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

      // Stream and log JSONL lines as they arrive for debugging visibility
      opencode.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        lineBuffer += chunk;

        // Process complete lines (JSONL - each line is a complete JSON object)
        const lines = lineBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          lineCount++;
          this.logStreamLine(line, lineCount, levelPrefix);
        }
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

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        logger.info(`${levelPrefix} OpenCode CLI completed - received ${lineCount} JSONL events`);

        // Parse the OpenCode JSONL response
        const parsed = this.parseOpenCodeResponse(stdout, level);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);

          // Log a summary of the response
          if (parsed.data?.suggestions) {
            const count = Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions.length : 0;
            logger.info(`${levelPrefix} [response] ${count} suggestions extracted`);
          } else if (parsed.data) {
            const jsonStr = JSON.stringify(parsed.data);
            logger.info(`${levelPrefix} [response] ${jsonStr.length} chars of JSON data`);
          }

          settle(resolve, parsed.data);
        } else {
          // Regex extraction failed, try LLM-based extraction as fallback
          logger.warn(`${levelPrefix} Regex extraction failed: ${parsed.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // Use async IIFE to handle the async LLM extraction
          (async () => {
            try {
              const llmExtracted = await this.extractJSONWithLLM(stdout, { level, analysisId, registerProcess });
              if (llmExtracted.success) {
                logger.success(`${levelPrefix} LLM extraction fallback succeeded`);
                settle(resolve, llmExtracted.data);
              } else {
                logger.warn(`${levelPrefix} LLM extraction fallback also failed: ${llmExtracted.error}`);
                logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
                settle(resolve, { raw: stdout, parsed: false });
              }
            } catch (llmError) {
              logger.warn(`${levelPrefix} LLM extraction fallback error: ${llmError.message}`);
              settle(resolve, { raw: stdout, parsed: false });
            }
          })();
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

      // Send the prompt to stdin (OpenCode reads from stdin when no positional args)
      // Note on error handling: When stdin.write fails, we kill the process which
      // triggers the 'close' event handler. The `settled` guard (line 142) prevents
      // double-settlement, so the race between reject() here and the close handler
      // is handled safely - whichever settles first wins, the other is ignored.
      opencode.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          opencode.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      opencode.stdin.end();
    });
  }

  /**
   * Log a streaming JSONL line for debugging visibility
   * Extracts meaningful info from each event type without being too verbose
   *
   * Uses logger.streamDebug() which only logs when --debug-stream flag is enabled.
   *
   * @param {string} line - A single JSONL line
   * @param {number} lineNum - Line number for reference
   * @param {string} levelPrefix - Level prefix for log messages
   */
  logStreamLine(line, lineNum, levelPrefix) {
    // Early exit if stream debugging is disabled
    if (!logger.isStreamDebugEnabled()) return;

    try {
      const event = JSON.parse(line);
      const type = event.type || 'unknown';

      // Log different event types with appropriate detail
      switch (type) {
        case 'step_start':
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Step started`);
          break;

        case 'step_finish': {
          const reason = event.part?.reason || 'unknown';
          const tokens = event.part?.tokens;
          if (tokens) {
            logger.streamDebug(
              `${levelPrefix} [#${lineNum}] Step finished (${reason}) - ` +
              `tokens: in=${tokens.input || 0}, out=${tokens.output || 0}, ` +
              `cache_read=${tokens.cache?.read || 0}`
            );
          } else {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] Step finished (${reason})`);
          }
          break;
        }

        case 'text': {
          const text = event.part?.text || event.text || '';
          const preview = text.length > 60 ? text.substring(0, 60) + '...' : text;
          // Only log if there's actual text content
          if (text.trim()) {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] text: ${preview.replace(/\n/g, '\\n')}`);
          }
          break;
        }

        case 'tool_call':
        case 'tool_use': {
          // Enhanced tool call/use logging with name and input preview
          // OpenCode tool_use format: { type: "tool_use", part: { type: "tool", tool: "name", callID: "...", state: { input: {...} } } }
          const part = event.part || {};
          const toolName = part.tool || part.name || part.tool_name || 'unknown';
          const toolId = part.callID || part.id || part.tool_use_id || '';

          // Extract input/arguments - may be in different fields depending on format
          // OpenCode uses part.state.input for tool arguments
          const toolInput = part.state?.input || part.input || part.arguments || part.args || null;
          let inputPreview = '';

          if (toolInput) {
            if (typeof toolInput === 'string') {
              // String input - show preview
              inputPreview = toolInput.length > 60 ? toolInput.substring(0, 60) + '...' : toolInput;
            } else if (typeof toolInput === 'object') {
              // Object input - show key fields
              const keys = Object.keys(toolInput);
              if (keys.length === 1 && typeof toolInput[keys[0]] === 'string') {
                // Single string field - show value preview
                const val = toolInput[keys[0]];
                inputPreview = `${keys[0]}="${val.length > 40 ? val.substring(0, 40) + '...' : val}"`;
              } else if (toolInput.command) {
                // Command execution - show command
                inputPreview = `cmd="${toolInput.command.substring(0, 50)}${toolInput.command.length > 50 ? '...' : ''}"`;
              } else if (toolInput.file_path || toolInput.path) {
                // File operation - show path
                inputPreview = `path="${toolInput.file_path || toolInput.path}"`;
              } else {
                // Multiple fields - show keys
                inputPreview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
              }
            }
          }

          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
          const inputPart = inputPreview ? ` ${inputPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] ${type}: ${toolName}${idPart}${inputPart}`);
          break;
        }

        case 'tool_result': {
          // Enhanced tool result logging with status/preview
          const part = event.part || {};
          const toolId = part.tool_use_id || part.id || '';
          const isError = part.is_error || part.error || false;
          const output = part.output || part.content || part.result || '';

          let resultPreview = '';
          if (typeof output === 'string' && output.length > 0) {
            resultPreview = output.length > 60 ? output.substring(0, 60) + '...' : output;
            resultPreview = resultPreview.replace(/\n/g, '\\n');
          } else if (Array.isArray(output) && output.length > 0) {
            resultPreview = `[${output.length} items]`;
          }

          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
          const statusPart = isError ? ' ERROR' : ' OK';
          const previewPart = resultPreview ? ` ${resultPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_result${idPart}${statusPart}${previewPart}`);
          break;
        }

        default:
          logger.streamDebug(`${levelPrefix} [#${lineNum}] ${type}`);
      }
    } catch {
      // If we can't parse the line, log the full content for debugging
      logger.streamDebug(`${levelPrefix} [#${lineNum}] (unparseable): ${line}`);
    }
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

          // Handle type: "text" with part.text (OpenCode JSONL format)
          // Format: {"type":"text","part":{"type":"text","text":"..."}}
          if (event.type === 'text' && event.part?.text) {
            textContent += event.part.text;
          }

          // Also handle direct text content (fallback)
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
   * Build args for OpenCode CLI execution, applying provider and model extra_args.
   * This ensures consistent arg construction for both execute() and getExtractionConfig().
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Base args for opencode run
    const baseArgs = ['run', '--model', model, '--format', 'json'];
    // Provider-level extra_args (from configOverrides)
    const providerArgs = this.configOverrides?.extra_args || [];
    // Model-specific extra_args (from the model config for the given model)
    const modelConfig = this.configOverrides?.models?.find(m => m.id === model);
    const modelArgs = modelConfig?.extra_args || [];

    return [...baseArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Get CLI configuration for LLM extraction
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // Use the already-resolved command from the constructor (this.opencodeCmd)
    // which respects: ENV > config > default precedence
    const opencodeCmd = this.opencodeCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    // For extraction, we pass the prompt via stdin
    // OpenCode reads from stdin when no positional message arguments are provided
    if (useShell) {
      return {
        command: `${opencodeCmd} ${args.join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true
      };
    }
    return {
      command: opencodeCmd,
      args,
      useShell: false,
      promptViaStdin: true
    };
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
