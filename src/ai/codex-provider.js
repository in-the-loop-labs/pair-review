// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Codex AI Provider
 *
 * Implements the AI provider interface for OpenAI's Codex CLI.
 * Uses the `codex exec` command for non-interactive execution.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parseCodexLine } = require('./stream-parser');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Codex model definitions with tier mappings
 *
 * Based on OpenAI Codex Models guide (developers.openai.com/codex/models)
 * - gpt-5.1-codex-mini: Smaller, cost-effective variant for quick scans
 * - gpt-5.1-codex-max: Optimized for long-horizon agentic coding tasks
 * - gpt-5.2-codex: Most advanced agentic coding model for real-world engineering
 */
const CODEX_MODELS = [
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Mini',
    tier: 'fast',
    tagline: 'Blazing Fast',
    description: 'Quick, low-cost reviews for style issues, obvious bugs, and lint-level feedback.',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Max',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Strong everyday reviewer—quality + speed for PR-sized changes and practical suggestions.',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2',
    tier: 'thorough',
    tagline: 'Deep Review',
    description: 'Most capable for complex diffs—finds subtle issues, reasons across files, and proposes step-by-step fixes.',
    badge: 'Most Thorough',
    badgeClass: 'badge-power'
  }
];

class CodexProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = 'gpt-5.1-codex-max', configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_CODEX_CMD;
    const configCmd = configOverrides.command;
    const codexCmd = envCmd || configCmd || 'codex';

    // Store for use in getExtractionConfig and testAvailability
    this.codexCmd = codexCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as Claude provider)
    this.useShell = codexCmd.includes(' ');

    // SECURITY: Codex sandbox modes and shell execution
    //
    // Codex sandbox modes:
    // - read-only: Can browse files but CANNOT run shell commands (too restrictive)
    // - workspace-write: Can read, edit, run commands in working directory only
    // - danger-full-access: Full system access (too permissive)
    //
    // For code review, we need shell commands (git, git-diff-lines) but don't need
    // network access or writes outside the worktree. We use "workspace-write" because:
    // 1. We run in a dedicated worktree, not the main repo
    // 2. "read-only" prevents ALL shell commands including git-diff-lines
    // 3. The AI is instructed to only analyze code, not modify it
    //
    // --full-auto: Non-interactive mode that auto-approves within sandbox bounds.
    // Combined with workspace-write sandbox, this limits damage to the worktree only.
    // Note: The -a flag is for interactive mode only; exec subcommand uses --full-auto.

    // Build args: base args + provider extra_args + model extra_args
    // In yolo mode, bypass all sandbox restrictions and approval prompts
    // (--dangerously-bypass-approvals-and-sandbox is the Codex CLI equivalent of Claude's --dangerously-skip-permissions)
    const sandboxArgs = configOverrides.yolo
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write', '--full-auto'];
    const baseArgs = ['exec', '-m', model, '--json', ...sandboxArgs, '-'];
    const providerArgs = configOverrides.extra_args || [];
    const modelConfig = configOverrides.models?.find(m => m.id === model);
    const modelArgs = modelConfig?.extra_args || [];

    // Merge env: provider env + model env
    this.extraEnv = {
      ...(configOverrides.env || {}),
      ...(modelConfig?.env || {})
    };

    if (this.useShell) {
      // In shell mode, build full command string with args
      this.command = `${codexCmd} ${[...baseArgs, ...providerArgs, ...modelArgs].join(' ')}`;
      this.args = [];
    } else {
      this.command = codexCmd;
      this.args = [...baseArgs, ...providerArgs, ...modelArgs];
    }
  }

  /**
   * Execute Codex CLI with a prompt
   * @param {string} prompt - The prompt to send to Codex
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Codex CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const codex = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = codex.pid;
      logger.info(`${levelPrefix} Spawned Codex CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, codex);
        logger.info(`${levelPrefix} Registered process ${pid} for analysis ${analysisId}`);
      }

      let stdout = '';
      let stderr = '';
      let timeoutId = null;
      let settled = false;  // Guard against multiple resolve/reject calls
      let lineBuffer = '';  // Buffer for incomplete JSONL lines
      let lineCount = 0;    // Count of JSONL events for progress tracking

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        fn(value);
      };

      // Set up side-channel stream parser for live progress events
      const streamParser = onStreamEvent
        ? new StreamParser(parseCodexLine, onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          codex.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Codex CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout with streaming JSONL parsing for debug visibility
      codex.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // Feed side-channel stream parser for live progress events
        if (streamParser) {
          streamParser.feed(chunk);
        }

        // Parse JSONL lines as they arrive for streaming debug output
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        // Keep the last incomplete line in buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            lineCount++;
            this.logStreamLine(line, lineCount, levelPrefix);
          }
        }
      });

      // Collect stderr
      codex.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      codex.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Codex CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Codex CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Codex CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Codex CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Log completion with event count (only for successful completion)
        logger.info(`${levelPrefix} Codex CLI completed: ${lineCount} JSONL events received`);

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        // Parse the Codex JSONL response
        const parsed = this.parseCodexResponse(stdout, level);
        if (parsed.success) {
          logger.success(`${levelPrefix} Successfully parsed JSON response`);
          // Dump the parsed data for debugging
          const dataPreview = JSON.stringify(parsed.data, null, 2);
          logger.debug(`${levelPrefix} [parsed_data] ${dataPreview.substring(0, 3000)}${dataPreview.length > 3000 ? '...' : ''}`);
          // Log suggestion count if present
          if (parsed.data?.suggestions) {
            const count = Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions.length : 0;
            logger.info(`${levelPrefix} [response] ${count} suggestions in parsed response`);
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
      codex.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Codex CLI not found. Please ensure Codex CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Codex CLI not found. ${CodexProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Codex process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      codex.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Send the prompt to stdin
      codex.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          codex.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      codex.stdin.end();
    });
  }

  /**
   * Parse Codex CLI JSONL response
   * Codex outputs JSONL with multiple event types:
   * - thread.started: Session info
   * - turn.started: Turn begins
   * - item.completed: Contains reasoning or agent_message items
   * - turn.completed: Turn ends with usage stats
   *
   * We need to extract the agent_message content which contains the AI response.
   *
   * @param {string} stdout - Raw stdout from Codex CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseCodexResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      // Accumulate text from ALL agent_message events, not just the last one.
      // When Codex uses tools, there may be multiple item.completed events with
      // agent_message type, and the response text may be spread across them.
      let agentMessageText = '';

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Accumulate text from agent_message items which contain the AI response
          // Multiple agent_message events can occur when Codex uses tools
          if (event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              event.item?.text) {
            agentMessageText += event.item.text;
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      if (agentMessageText) {
        // The accumulated agent_message text contains the AI's response
        // Try to extract JSON from it (the AI was asked to output JSON)
        logger.debug(`${levelPrefix} Extracted ${agentMessageText.length} chars of agent message text from JSONL`);
        const extracted = extractJSON(agentMessageText, level);
        if (extracted.success) {
          return extracted;
        }

        // If no JSON found, return the raw message
        logger.warn(`${levelPrefix} Agent message is not JSON, treating as raw text`);
        return { success: false, error: 'Agent message is not valid JSON' };
      }

      // No agent message found, try extracting JSON directly from stdout
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
   * Log a streaming JSONL line for debugging visibility
   * Codex JSONL format event types:
   * - thread.started: Session info
   * - turn.started: Turn begins
   * - item.completed: Contains reasoning, agent_message, or tool items
   * - turn.completed: Turn ends with usage stats
   *
   * Uses logger.streamDebug() which only logs when --debug-stream flag is enabled.
   *
   * @param {string} line - A single JSONL line
   * @param {number} lineNum - Line number for reference
   * @param {string} levelPrefix - Logging prefix
   */
  logStreamLine(line, lineNum, levelPrefix) {
    // Check stream debug status - branches exit early if disabled
    const streamEnabled = logger.isStreamDebugEnabled();

    try {
      const event = JSON.parse(line);
      const eventType = event.type;

      if (eventType === 'thread.started') {
        if (!streamEnabled) return;
        const threadId = event.thread_id || '';
        const idPart = threadId ? ` thread=${threadId.substring(0, 12)}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] thread.started${idPart}`);

      } else if (eventType === 'turn.started') {
        if (!streamEnabled) return;
        const turnId = event.turn_id || '';
        const idPart = turnId ? ` turn=${turnId.substring(0, 8)}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] turn.started${idPart}`);

      } else if (eventType === 'item.completed') {
        const item = event.item || {};
        const itemType = item.type || 'unknown';

        if (itemType === 'agent_message') {
          // Agent message - this is the AI's text response
          const text = item.text || '';
          if (text && streamEnabled) {
            const preview = text.replace(/\n/g, '\\n').substring(0, 60);
            logger.streamDebug(`${levelPrefix} [#${lineNum}] agent_message: ${preview}${text.length > 60 ? '...' : ''}`);
          } else if (streamEnabled) {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] agent_message (empty)`);
          }

        } else if (itemType === 'function_call' || itemType === 'tool_call' || itemType === 'tool_use') {
          if (!streamEnabled) return;
          // Tool/function call - extract name and input
          const toolName = item.name || item.tool || 'unknown';
          const toolId = item.id || item.call_id || '';
          const toolArgs = item.arguments || item.input || item.args || null;

          let argsPreview = '';
          if (toolArgs) {
            // Try to parse if it's a string (Codex often stringifies arguments)
            let parsedArgs = toolArgs;
            if (typeof toolArgs === 'string') {
              try {
                parsedArgs = JSON.parse(toolArgs);
              } catch {
                parsedArgs = toolArgs;
              }
            }

            if (typeof parsedArgs === 'string') {
              argsPreview = parsedArgs.length > 50 ? parsedArgs.substring(0, 50) + '...' : parsedArgs;
            } else if (typeof parsedArgs === 'object' && parsedArgs !== null) {
              const keys = Object.keys(parsedArgs);
              if (parsedArgs.command) {
                const cmd = parsedArgs.command;
                argsPreview = `cmd="${cmd.substring(0, 50)}${cmd.length > 50 ? '...' : ''}"`;
              } else if (parsedArgs.file_path || parsedArgs.path) {
                argsPreview = `path="${parsedArgs.file_path || parsedArgs.path}"`;
              } else if (keys.length === 1 && typeof parsedArgs[keys[0]] === 'string') {
                const val = parsedArgs[keys[0]];
                argsPreview = `${keys[0]}="${val.length > 40 ? val.substring(0, 40) + '...' : val}"`;
              } else if (keys.length > 0) {
                argsPreview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
              }
            }
          }

          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
          const argsPart = argsPreview ? ` ${argsPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_call: ${toolName}${idPart}${argsPart}`);

        } else if (itemType === 'function_call_output' || itemType === 'tool_result') {
          if (!streamEnabled) return;
          // Tool result
          const toolId = item.call_id || item.tool_use_id || item.id || '';
          const output = item.output || item.result || item.content || '';
          const isError = item.is_error || item.error || false;

          let resultPreview = '';
          if (typeof output === 'string' && output.length > 0) {
            resultPreview = output.length > 60 ? output.substring(0, 60) + '...' : output;
            resultPreview = resultPreview.replace(/\n/g, '\\n');
          }

          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
          const statusPart = isError ? ' ERROR' : ' OK';
          const previewPart = resultPreview ? ` ${resultPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_result${idPart}${statusPart}${previewPart}`);

        } else if (itemType === 'reasoning') {
          if (!streamEnabled) return;
          // Reasoning item - show brief summary
          const summary = item.summary || '';
          const preview = summary ? summary.substring(0, 50) : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] reasoning: ${preview}${summary.length > 50 ? '...' : ''}`);

        } else if (streamEnabled) {
          // Other item types
          logger.streamDebug(`${levelPrefix} [#${lineNum}] item.completed (${itemType})`);
        }

      } else if (eventType === 'turn.completed') {
        // Turn completed - always log this at info level for summary
        const usage = event.usage || {};
        const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
        const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || (inputTokens + outputTokens);

        logger.info(`${levelPrefix} [turn.completed] tokens: ${inputTokens}in/${outputTokens}out (total: ${totalTokens})`);

      } else if (eventType && streamEnabled) {
        // Unknown event type - only log if we have an actual type and stream debug is on
        logger.streamDebug(`${levelPrefix} [#${lineNum}] ${eventType}`);
      }
      // Silently ignore events with no type

    } catch (parseError) {
      if (streamEnabled) {
        // Skip malformed lines
        logger.streamDebug(`${levelPrefix} [#${lineNum}] (malformed: ${line.substring(0, 50)}${line.length > 50 ? '...' : ''})`);
      }
    }
  }

  /**
   * Build args for Codex CLI extraction, applying provider and model extra_args.
   * This ensures consistent arg construction for getExtractionConfig().
   *
   * Note: For extraction, we use minimal sandbox (read-only) since we don't need
   * shell commands for JSON extraction.
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Base args for extraction (read-only sandbox, no shell access needed)
    // Note: '-' (stdin marker) must come LAST, after any extra_args
    const baseArgs = ['exec', '-m', model, '--json', '--sandbox', 'read-only', '--full-auto'];
    // Provider-level extra_args (from configOverrides)
    const providerArgs = this.configOverrides?.extra_args || [];
    // Model-specific extra_args (from the model config for the given model)
    const modelConfig = this.configOverrides?.models?.find(m => m.id === model);
    const modelArgs = modelConfig?.extra_args || [];

    // Append stdin marker '-' at the end after all other args
    return [...baseArgs, ...providerArgs, ...modelArgs, '-'];
  }

  /**
   * Get CLI configuration for LLM extraction
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // Use the already-resolved command from the constructor (this.codexCmd)
    // which respects: ENV > config > default precedence
    const codexCmd = this.codexCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    if (useShell) {
      return {
        command: `${codexCmd} ${args.join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true
      };
    }
    return {
      command: codexCmd,
      args,
      useShell: false,
      promptViaStdin: true
    };
  }

  /**
   * Test if Codex CLI is available
   * Uses fast `--version` check instead of running a prompt.
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.codexCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.codexCmd} --version` : this.codexCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Codex availability check: ${fullCmd}`);

      const codex = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Timeout guard: if the CLI hangs, resolve false
      const availabilityTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn('Codex CLI availability check timed out after 10s');
        try { codex.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 10000);

      codex.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      codex.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      codex.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`Codex CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          const stderrMsg = stderr.trim() ? `: ${stderr.trim()}` : '';
          logger.warn(`Codex CLI not available or returned unexpected output (exit code ${code})${stderrMsg}`);
          resolve(false);
        }
      });

      codex.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Codex CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Codex';
  }

  static getProviderId() {
    return 'codex';
  }

  static getModels() {
    return CODEX_MODELS;
  }

  static getDefaultModel() {
    return 'gpt-5.1-codex-max';
  }

  static getInstallInstructions() {
    return 'Install Codex CLI: npm install -g @openai/codex\n' +
           'Or visit: https://github.com/openai/codex';
  }
}

// Register this provider
registerProvider('codex', CodexProvider);

module.exports = CodexProvider;
