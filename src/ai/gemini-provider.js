// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Gemini AI Provider
 *
 * Implements the AI provider interface for Google's Gemini CLI.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider, quoteShellArgs } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parseGeminiLine } = require('./stream-parser');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Gemini model definitions with tier mappings
 */
const GEMINI_MODELS = [
  {
    id: 'gemini-3-flash-preview',
    name: '3.0 Flash',
    tier: 'fast',
    tagline: 'Rapid Sanity Check',
    description: 'Fast and capable at a fraction of the cost of larger models',
    badge: 'Quick Look',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-2.5-pro',
    name: '2.5 Pro',
    tier: 'balanced',
    tagline: 'Standard PR Review',
    description: 'Strong reasoning with large context window—reliable for everyday code reviews',
    badge: 'Daily Driver',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'gemini-3-pro-preview',
    name: '3.0 Pro',
    tier: 'thorough',
    tagline: 'Architectural Audit',
    description: 'Most intelligent Gemini model—advanced reasoning for deep architectural analysis',
    badge: 'Deep Dive',
    badgeClass: 'badge-power'
  }
];

class GeminiProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = 'gemini-2.5-pro', configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_GEMINI_CMD;
    const configCmd = configOverrides.command;
    const geminiCmd = envCmd || configCmd || 'gemini';

    // Store for use in getExtractionConfig and testAvailability
    this.geminiCmd = geminiCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as Claude provider)
    this.useShell = geminiCmd.includes(' ');

    // ============================================================================
    // SECURITY LIMITATION - READ CAREFULLY
    // ============================================================================
    //
    // IMPORTANT: Unlike Claude and Copilot providers, Gemini CLI does NOT have a
    // mechanism to restrict which tools the model can request. The --allowed-tools
    // flag only controls which tools are AUTO-APPROVED (no interactive prompt), but
    // all tools remain available to the model.
    //
    // Gemini tool names (from asking the CLI):
    // - list_directory, read_file, search_file_content, glob: File system read operations
    // - run_shell_command: Execute shell commands (needed for git, git-diff-lines)
    // - google_web_search: Web search
    // - write_file, replace: Write operations (NOT auto-approved but still available)
    //
    // In non-interactive mode (-o json), if the model requests a tool not in --allowed-tools,
    // the operation may fail or the tool may still execute without explicit user approval.
    //
    // MITIGATION STRATEGY:
    // 1. Prompt engineering: The analysis prompts in analyzer.js explicitly instruct
    //    the AI to only use read-only operations and never modify files
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Shell command restrictions: Use prefix-based allowlist for shell commands
    //
    // If a mechanism to restrict tool visibility becomes available in Gemini CLI,
    // it should be added here similar to Copilot's --excluded-tools flag.
    // ============================================================================
    //
    // SHELL COMMAND PREFIX SYNTAX:
    // The --allowed-tools flag supports prefix matching via run_shell_command(prefix).
    // E.g., run_shell_command(git) allows "git status", "git diff", etc.
    // Commands NOT matching any prefix will be denied in non-interactive mode.
    // ============================================================================
    // Build args: base args + provider extra_args + model extra_args
    // Use --output-format stream-json for JSONL streaming output (better debugging visibility)
    let baseArgs;
    if (configOverrides.yolo) {
      // In yolo mode, use Gemini's --yolo flag to auto-approve all tools
      // (including write operations and destructive shell commands)
      baseArgs = ['-m', model, '-o', 'stream-json', '--yolo'];
    } else {
      const readOnlyTools = [
        // File system tools (read-only)
        'list_directory',
        'read_file',
        'glob',
        'search_file_content',
        // Specific read-only git commands (not blanket 'git' to avoid git commit, push, etc.)
        'run_shell_command(git diff)',
        'run_shell_command(git log)',
        'run_shell_command(git show)',
        'run_shell_command(git status)',
        'run_shell_command(git branch)',
        'run_shell_command(git rev-parse)',
        'run_shell_command(git sparse-checkout)',
        // Read-only shell commands
        'run_shell_command(ls)',           // Directory listing
        'run_shell_command(cat)',          // File content viewing
        'run_shell_command(pwd)',          // Current directory
        'run_shell_command(head)',         // File head viewing
        'run_shell_command(tail)',         // File tail viewing
        'run_shell_command(wc)',           // Word/line count
        'run_shell_command(find)',         // File finding
        'run_shell_command(grep)',         // Pattern searching
        'run_shell_command(rg)',           // Ripgrep (fast pattern searching)
        // git-diff-lines is added to PATH via BIN_DIR so bare command works
        'run_shell_command(git-diff-lines)', // Custom annotated diff tool
      ].join(',');
      baseArgs = ['-m', model, '-o', 'stream-json', '--allowed-tools', readOnlyTools];
    }
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
      // Quote all args to prevent shell interpretation of special characters
      // (commas, parentheses in patterns like "run_shell_command(git diff)")
      this.command = `${geminiCmd} ${quoteShellArgs([...baseArgs, ...providerArgs, ...modelArgs]).join(' ')}`;
      this.args = [];
    } else {
      this.command = geminiCmd;
      this.args = [...baseArgs, ...providerArgs, ...modelArgs];
    }
  }

  /**
   * Execute Gemini CLI with a prompt
   * @param {string} prompt - The prompt to send to Gemini
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Gemini CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const gemini = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = gemini.pid;
      logger.info(`${levelPrefix} Spawned Gemini CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, gemini);
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
        ? new StreamParser(parseGeminiLine, onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          gemini.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Gemini CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout with streaming JSONL parsing for debug visibility
      gemini.stdout.on('data', (data) => {
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
      gemini.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      gemini.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Gemini CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Gemini CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Gemini CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Gemini CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Gemini CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Log completion with event count (only for successful completion)
        logger.info(`${levelPrefix} Gemini CLI completed: ${lineCount} JSONL events received`);

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        // Parse the Gemini JSONL stream response
        const parsed = this.parseGeminiResponse(stdout, level);
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
          const llmFallbackInput = parsed.textContent || stdout;
          logger.info(`${levelPrefix} LLM fallback input length: ${llmFallbackInput.length} characters (${parsed.textContent ? 'text content' : 'raw stdout'})`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // Use async IIFE to handle the async LLM extraction
          (async () => {
            try {
              const llmExtracted = await this.extractJSONWithLLM(llmFallbackInput, { level, analysisId, registerProcess });
              if (llmExtracted.success) {
                logger.success(`${levelPrefix} LLM extraction fallback succeeded`);
                settle(resolve, llmExtracted.data);
              } else {
                logger.warn(`${levelPrefix} LLM extraction fallback also failed: ${llmExtracted.error}`);
                logger.info(`${levelPrefix} Raw response preview: ${llmFallbackInput.substring(0, 500)}...`);
                settle(resolve, { raw: llmFallbackInput, parsed: false });
              }
            } catch (llmError) {
              logger.warn(`${levelPrefix} LLM extraction fallback error: ${llmError.message}`);
              settle(resolve, { raw: llmFallbackInput, parsed: false });
            }
          })();
        }
      });

      // Handle errors
      gemini.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Gemini CLI not found. Please ensure Gemini CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Gemini CLI not found. ${GeminiProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Gemini process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      gemini.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Send the prompt to stdin
      gemini.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          gemini.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      gemini.stdin.end();
    });
  }

  /**
   * Parse Gemini CLI JSONL stream response
   * Gemini with -o stream-json outputs JSONL with multiple event types:
   * - init: Session initialization with model info
   * - message (role: "user"): User message echo
   * - message (role: "assistant"): Assistant text (may have delta: true for streaming chunks,
   *   but we accumulate ALL assistant messages with content regardless of delta flag)
   * - tool_use: Tool invocation with tool_name, tool_id, parameters
   * - tool_result: Tool result with status and output
   * - result: Final result with stats (total_tokens, input_tokens, output_tokens)
   *
   * We need to accumulate text from assistant messages and extract JSON from them.
   *
   * @param {string} stdout - Raw stdout from Gemini CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseGeminiResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      // Accumulate text from ALL assistant message events with delta: true
      // The AI's response may be spread across multiple streaming chunks
      let assistantText = '';

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Accumulate text from assistant messages which contain the AI response
          // Multiple message events can occur as streaming chunks arrive
          if (event.type === 'message' &&
              event.role === 'assistant' &&
              event.content) {
            assistantText += event.content;
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      if (assistantText) {
        // The accumulated assistant text contains the AI's response
        // Try to extract JSON from it (the AI was asked to output JSON)
        logger.debug(`${levelPrefix} Extracted ${assistantText.length} chars of assistant message text from JSONL`);
        const extracted = extractJSON(assistantText, level);
        if (extracted.success) {
          return extracted;
        }

        // If no JSON found, return with textContent so the caller can
        // pass it (not raw JSONL stdout) to the LLM extraction fallback
        logger.warn(`${levelPrefix} Assistant message is not JSON, treating as raw text`);
        return { success: false, error: 'Assistant message is not valid JSON', textContent: assistantText };
      }

      // No assistant message found, try extracting JSON directly from stdout
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
   * Gemini stream-json format event types:
   * - init: Session initialization with model info
   * - message (role: "user"): User message echo
   * - message (role: "assistant", delta: true): Streaming assistant text chunks
   * - tool_use: Tool invocation with tool_name, tool_id, parameters
   * - tool_result: Tool result with status and output
   * - result: Final result with stats
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

      if (eventType === 'init') {
        if (!streamEnabled) return;
        const sessionId = event.session_id || '';
        const model = event.model || '';
        const sessionPart = sessionId ? ` session=${sessionId.substring(0, 12)}` : '';
        const modelPart = model ? ` model=${model}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] init${sessionPart}${modelPart}`);

      } else if (eventType === 'message') {
        if (!streamEnabled) return;
        const role = event.role || 'unknown';
        const content = event.content || '';
        const isDelta = event.delta === true;

        if (role === 'assistant') {
          // Assistant message - this is the AI's text response
          if (content) {
            const preview = content.replace(/\n/g, '\\n').substring(0, 60);
            const deltaPart = isDelta ? ' (delta)' : '';
            logger.streamDebug(`${levelPrefix} [#${lineNum}] message[assistant]${deltaPart}: ${preview}${content.length > 60 ? '...' : ''}`);
          } else {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] message[assistant] (empty)`);
          }
        } else if (role === 'user') {
          // User message echo - brief log
          const preview = content.replace(/\n/g, '\\n').substring(0, 40);
          logger.streamDebug(`${levelPrefix} [#${lineNum}] message[user]: ${preview}${content.length > 40 ? '...' : ''}`);
        } else {
          // Unknown role
          logger.streamDebug(`${levelPrefix} [#${lineNum}] message[${role}]`);
        }

      } else if (eventType === 'tool_use') {
        if (!streamEnabled) return;
        // Tool invocation - extract name and parameters
        const toolName = event.tool_name || 'unknown';
        const toolId = event.tool_id || '';
        const params = event.parameters || null;

        let paramsPreview = '';
        if (params && typeof params === 'object') {
          const keys = Object.keys(params);
          if (params.command) {
            const cmd = params.command;
            paramsPreview = `cmd="${cmd.substring(0, 50)}${cmd.length > 50 ? '...' : ''}"`;
          } else if (params.file_path || params.path) {
            paramsPreview = `path="${params.file_path || params.path}"`;
          } else if (keys.length === 1 && typeof params[keys[0]] === 'string') {
            const val = params[keys[0]];
            paramsPreview = `${keys[0]}="${val.length > 40 ? val.substring(0, 40) + '...' : val}"`;
          } else if (keys.length > 0) {
            paramsPreview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
          }
        }

        const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
        const paramsPart = paramsPreview ? ` ${paramsPreview}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_use: ${toolName}${idPart}${paramsPart}`);

      } else if (eventType === 'tool_result') {
        if (!streamEnabled) return;
        // Tool result
        const toolId = event.tool_id || '';
        const status = event.status || 'unknown';
        const output = event.output || '';
        const isError = status === 'error';

        let resultPreview = '';
        if (typeof output === 'string' && output.length > 0) {
          resultPreview = output.length > 60 ? output.substring(0, 60) + '...' : output;
          resultPreview = resultPreview.replace(/\n/g, '\\n');
        }

        const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
        const statusPart = isError ? ' ERROR' : ' OK';
        const previewPart = resultPreview ? ` ${resultPreview}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_result${idPart}${statusPart}${previewPart}`);

      } else if (eventType === 'result') {
        // Final result - always log this at info level (not stream debug)
        const stats = event.stats || {};
        const inputTokens = stats.input_tokens || 0;
        const outputTokens = stats.output_tokens || 0;
        const totalTokens = stats.total_tokens || (inputTokens + outputTokens);
        const durationMs = stats.duration_ms || 0;
        const toolCalls = stats.tool_calls || 0;

        const durationPart = durationMs ? ` duration=${durationMs}ms` : '';
        const toolsPart = toolCalls ? ` tools=${toolCalls}` : '';
        logger.info(`${levelPrefix} [result] tokens: ${inputTokens}in/${outputTokens}out (total: ${totalTokens})${durationPart}${toolsPart}`);

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
   * Build args for Gemini CLI extraction, applying provider and model extra_args.
   * This ensures consistent arg construction for getExtractionConfig().
   *
   * Note: For extraction, we use text output (-o text) to get raw JSON without wrapper.
   * This avoids needing parseGeminiResponse which expects the JSONL stream format.
   * No --allowed-tools needed since extraction doesn't use tools.
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Base args for extraction (text output, no tools needed)
    // Use text format for simpler JSON parsing; analysis uses stream-json for progress feedback and tool visibility
    const baseArgs = ['-m', model, '-o', 'text'];
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
    // Use the already-resolved command from the constructor (this.geminiCmd)
    // which respects: ENV > config > default precedence
    const geminiCmd = this.geminiCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    // For extraction, we pass the prompt via stdin
    if (useShell) {
      return {
        command: `${geminiCmd} ${quoteShellArgs(args).join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true
      };
    }
    return {
      command: geminiCmd,
      args,
      useShell: false,
      promptViaStdin: true
    };
  }

  /**
   * Test if Gemini CLI is available
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.geminiCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.geminiCmd} --version` : this.geminiCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Gemini availability check: ${fullCmd}`);

      const gemini = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      gemini.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gemini.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && stdout.includes('.')) {
          logger.info(`Gemini CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Gemini CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      gemini.on('error', (error) => {
        if (settled) return;
        settled = true;
        logger.warn(`Gemini CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Gemini';
  }

  static getProviderId() {
    return 'gemini';
  }

  static getModels() {
    return GEMINI_MODELS;
  }

  static getDefaultModel() {
    return 'gemini-2.5-pro';
  }

  static getInstallInstructions() {
    return 'Install Gemini CLI: npm install -g @google/gemini-cli\n' +
           'Or visit: https://github.com/google-gemini/gemini-cli';
  }
}

// Register this provider
registerProvider('gemini', GeminiProvider);

module.exports = GeminiProvider;
