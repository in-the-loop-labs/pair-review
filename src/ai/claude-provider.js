// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Claude AI Provider
 *
 * Wraps the Claude CLI for use with the AI provider abstraction.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parseClaudeLine } = require('./stream-parser');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Claude model definitions with tier mappings
 */
const CLAUDE_MODELS = [
  {
    id: 'haiku',
    name: 'Haiku',
    tier: 'fast',
    tagline: 'Lightning Fast',
    description: 'Quick analysis for simple changes',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'sonnet',
    name: 'Sonnet',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Recommended for most reviews',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'opus',
    name: 'Opus',
    tier: 'thorough',
    tagline: 'Most Capable',
    description: 'Deep analysis for complex code',
    badge: 'Most Thorough',
    badgeClass: 'badge-power'
  }
];

class ClaudeProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = 'sonnet', configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_CLAUDE_CMD;
    const configCmd = configOverrides.command;
    const claudeCmd = envCmd || configCmd || 'claude';

    // Store for use in getExtractionConfig and testAvailability
    this.claudeCmd = claudeCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands like "devx claude", use shell mode
    this.useShell = claudeCmd.includes(' ');

    // SECURITY: Claude CLI with -p (print mode) requires explicit tool permissions.
    // We use --allowedTools to grant only read-only operations needed for code review:
    // - Read: Read file contents
    // - Bash(git *): Git commands (read operations like diff, log, show, status)
    // - Bash(*git-diff-lines*): Our annotated diff script
    // - Bash(cat *), Bash(ls *), Bash(grep *), Bash(find *): Read-only shell commands
    //
    // Dangerous operations (Write, Edit, Bash(rm *), Bash(git push*), etc.) are NOT allowed.
    const allowedTools = [
      'Read',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(git show*)',
      'Bash(git status*)',
      'Bash(git branch*)',
      'Bash(git rev-parse*)',
      'Bash(*git-diff-lines*)',
      'Bash(cat *)',
      'Bash(ls *)',
      'Bash(head *)',
      'Bash(tail *)',
      'Bash(grep *)',
      'Bash(find *)',
      'Bash(rg *)',
    ].join(',');

    // Check for budget limit environment variable
    const maxBudget = process.env.PAIR_REVIEW_MAX_BUDGET_USD;

    // Build args: base args + provider extra_args + model extra_args
    // Use --output-format stream-json for JSONL streaming output (better debugging visibility)
    //
    // IMPORTANT: --verbose is MANDATORY when combining --output-format stream-json with -p (print mode).
    // Without --verbose, the stream-json output is incomplete or malformed in print mode.
    // This is a known requirement of the Claude CLI - do not remove --verbose from these args.
    const baseArgs = ['-p', '--verbose', '--model', model, '--output-format', 'stream-json', '--allowedTools', allowedTools];
    if (maxBudget) {
      baseArgs.push('--max-budget-usd', maxBudget);
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
      // Quote the allowedTools value to prevent shell interpretation of special characters
      // (commas, parentheses in patterns like "Bash(git diff*)")
      const quotedBaseArgs = baseArgs.map((arg, i) => {
        // The allowedTools value follows the --allowedTools flag
        if (baseArgs[i - 1] === '--allowedTools') {
          return `'${arg}'`;
        }
        return arg;
      });
      this.command = `${claudeCmd} ${[...quotedBaseArgs, ...providerArgs, ...modelArgs].join(' ')}`;
      this.args = [];
    } else {
      this.command = claudeCmd;
      this.args = [...baseArgs, ...providerArgs, ...modelArgs];
    }
  }

  /**
   * Execute Claude CLI with a prompt
   * @param {string} prompt - The prompt to send to Claude
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Claude CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} bytes`);

      const claude = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = claude.pid;
      logger.info(`${levelPrefix} Spawned Claude CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, claude);
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
        ? new StreamParser(parseClaudeLine, onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          claude.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Claude CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout with streaming JSONL parsing for debug visibility
      claude.stdout.on('data', (data) => {
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
            this.logStreamLine(line, levelPrefix);
          }
        }
      });

      // Collect stderr
      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      claude.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Claude CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Claude CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Claude CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Claude CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Claude CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Log completion with event count
        logger.info(`${levelPrefix} Claude CLI completed: ${lineCount} JSONL events received`);

        // Parse the Claude JSONL stream response
        const parsed = this.parseClaudeResponse(stdout, level);
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
      claude.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Claude CLI not found. Please ensure Claude CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Claude CLI not found. ${ClaudeProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Claude process error: ${error}`);
          settle(reject, error);
        }
      });

      // Send the prompt to stdin
      claude.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          claude.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      claude.stdin.end();
    });
  }

  /**
   * Build args for Claude CLI extraction, applying provider and model extra_args.
   * This ensures consistent arg construction for getExtractionConfig().
   *
   * Note: For extraction, we use simple -p mode without --allowedTools since
   * extraction doesn't need tool access.
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Base args for extraction (simple prompt mode, no tools needed)
    const baseArgs = ['-p', '--model', model];
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
    // Use the already-resolved command from the constructor (this.claudeCmd)
    // which respects: ENV > config > default precedence
    const claudeCmd = this.claudeCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    if (useShell) {
      return {
        command: `${claudeCmd} ${args.join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true
      };
    }
    return {
      command: claudeCmd,
      args,
      useShell: false,
      promptViaStdin: true
    };
  }

  /**
   * Log a streaming JSONL line for debugging visibility
   * Claude stream-json format:
   * - stream_event with content_block_delta: text fragments
   * - assistant messages: tool calls and results
   * - result: final result with text content
   *
   * Uses logger.streamDebug() which only logs when --debug-stream flag is enabled.
   *
   * @param {string} line - A single JSONL line
   * @param {string} levelPrefix - Logging prefix
   */
  logStreamLine(line, levelPrefix) {
    // Early exit if stream debugging is disabled (except for result which always logs to info)
    const streamEnabled = logger.isStreamDebugEnabled();

    try {
      const event = JSON.parse(line);
      const eventType = event.type;

      if (eventType === 'stream_event') {
        if (!streamEnabled) return;
        // Streaming text delta
        const delta = event.event?.delta;
        if (delta?.type === 'text_delta' && delta?.text) {
          // Log text fragments at debug level (can be very frequent)
          const preview = delta.text.replace(/\n/g, '\\n').substring(0, 60);
          logger.streamDebug(`${levelPrefix} text: ${preview}${delta.text.length > 60 ? '...' : ''}`);
        }
      } else if (eventType === 'assistant') {
        if (!streamEnabled) return;
        // Assistant turn with tool use or message - extract useful info
        const content = event.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            // Tool use block - show name and input preview
            const toolName = block.name || 'unknown';
            const toolId = block.id || '';
            const toolInput = block.input || {};

            let inputPreview = '';
            if (typeof toolInput === 'object') {
              const keys = Object.keys(toolInput);
              if (toolInput.command) {
                // Command execution
                inputPreview = `cmd="${toolInput.command.substring(0, 50)}${toolInput.command.length > 50 ? '...' : ''}"`;
              } else if (toolInput.file_path || toolInput.path) {
                // File operation
                inputPreview = `path="${toolInput.file_path || toolInput.path}"`;
              } else if (keys.length === 1 && typeof toolInput[keys[0]] === 'string') {
                // Single string field
                const val = toolInput[keys[0]];
                inputPreview = `${keys[0]}="${val.length > 40 ? val.substring(0, 40) + '...' : val}"`;
              } else if (keys.length > 0) {
                inputPreview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
              }
            }

            const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
            const inputPart = inputPreview ? ` ${inputPreview}` : '';
            logger.streamDebug(`${levelPrefix} tool_use: ${toolName}${idPart}${inputPart}`);
          } else if (block.type === 'text' && block.text) {
            const preview = block.text.replace(/\n/g, '\\n').substring(0, 60);
            logger.streamDebug(`${levelPrefix} assistant_text: ${preview}${block.text.length > 60 ? '...' : ''}`);
          }
        }
      } else if (eventType === 'user') {
        if (!streamEnabled) return;
        // Tool result - extract useful info
        const content = event.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolId = block.tool_use_id || '';
            const isError = block.is_error || false;
            const output = block.content || '';

            let resultPreview = '';
            if (typeof output === 'string' && output.length > 0) {
              resultPreview = output.length > 60 ? output.substring(0, 60) + '...' : output;
              resultPreview = resultPreview.replace(/\n/g, '\\n');
            } else if (Array.isArray(output)) {
              // Content array format
              for (const item of output) {
                if (item.type === 'text' && item.text) {
                  const text = item.text;
                  resultPreview = text.length > 60 ? text.substring(0, 60) + '...' : text;
                  resultPreview = resultPreview.replace(/\n/g, '\\n');
                  break;
                }
              }
            }

            const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';
            const statusPart = isError ? ' ERROR' : ' OK';
            const previewPart = resultPreview ? ` ${resultPreview}` : '';
            logger.streamDebug(`${levelPrefix} tool_result${idPart}${statusPart}${previewPart}`);
          }
        }
      } else if (eventType === 'result') {
        // Final result - always log this at info level (not stream debug)
        const cost = event.cost_usd ? `$${event.cost_usd.toFixed(4)}` : 'unknown';
        const tokens = event.usage ? `${event.usage.input_tokens}in/${event.usage.output_tokens}out` : '';

        // Extract text content from result for a preview
        let textPreview = '';
        if (event.result?.content) {
          for (const block of event.result.content) {
            if (block.type === 'text' && block.text) {
              textPreview += block.text;
            }
          }
        }

        // Log the result summary
        logger.info(`${levelPrefix} [result] cost=${cost} tokens=${tokens}`);

        // Show a preview of the actual response content
        if (textPreview) {
          const charCount = textPreview.length;
          const preview = textPreview.replace(/\s+/g, ' ').substring(0, 100);
          logger.info(`${levelPrefix} [response] ${charCount} chars: ${preview}${charCount > 100 ? '...' : ''}`);
        }
      } else if (eventType === 'system') {
        // System messages are not useful for debugging - silently ignore
      } else if (eventType && streamEnabled) {
        // Unknown event type - only log if we have an actual type and stream debug is on
        logger.streamDebug(`${levelPrefix} ${eventType}`);
      }
      // Silently ignore events with no type
    } catch (parseError) {
      if (streamEnabled) {
        // Skip malformed lines
        logger.streamDebug(`${levelPrefix} (malformed: ${line.substring(0, 50)}...)`);
      }
    }
  }

  /**
   * Parse Claude CLI JSONL stream response
   * Claude with --output-format stream-json outputs JSONL with:
   * - stream_event: text deltas during streaming
   * - assistant: tool calls
   * - user: tool results
   * - result: final result with text content
   *
   * We need to extract the text from the result message.
   *
   * @param {string} stdout - Raw stdout from Claude CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseClaudeResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      let textContent = '';
      let resultEvent = null;
      let assistantText = '';  // Fallback: collect text from assistant events

      // Parse all events to find result and collect assistant text as fallback
      // Assistant text that matters comes BEFORE the result event
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            resultEvent = event;
            break; // Result is the final authoritative event, stop here
          } else if (event.type === 'assistant') {
            // Collect text from assistant events as fallback
            // When Claude uses tools, the final response text may be in assistant
            // events rather than the result event
            const content = event.message?.content || [];
            for (const block of content) {
              if (block.type === 'tool_use') {
                // Clear accumulated text when we see a tool_use block.
                // In multi-turn tool usage, earlier assistant messages contain reasoning
                // or partial responses that aren't the final JSON output. By clearing here,
                // we ensure only text AFTER the last tool interaction is captured,
                // which is most likely to contain the final structured response.
                assistantText = '';
              } else if (block.type === 'text' && block.text) {
                assistantText += block.text;
              }
            }
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      // Extract content from result event (primary source)
      if (resultEvent) {
        // Check for subresult first (structured output takes precedence)
        // When subresult exists, it is the authoritative structured response and
        // any text content from earlier events is intentionally ignored.
        if (resultEvent.result?.subresult) {
          const subresult = resultEvent.result.subresult;
          if (typeof subresult === 'object') {
            return { success: true, data: subresult };
          }
        }

        // Extract text from result.content
        if (resultEvent.result?.content) {
          for (const block of resultEvent.result.content) {
            if (block.type === 'text' && block.text) {
              textContent += block.text;
            }
          }
        }
      }

      // If no text in result event, fall back to accumulated assistant text
      // This handles cases where Claude uses tools and the response is spread
      // across assistant events rather than being in the result event
      if (!textContent && assistantText) {
        logger.info(`${levelPrefix} No text in result event, using accumulated assistant text (${assistantText.length} chars)`);
        textContent = assistantText;
      }

      if (textContent) {
        logger.debug(`${levelPrefix} Extracted ${textContent.length} chars of text content from JSONL`);
        // Try to extract JSON from the accumulated text content
        const extracted = extractJSON(textContent, level);
        if (extracted.success) {
          return extracted;
        }

        // If no JSON found, return the raw text
        logger.warn(`${levelPrefix} Text content is not JSON, treating as raw text`);
        return { success: false, error: 'Text content is not valid JSON' };
      }

      // No text content found - don't fall back to raw stdout extraction
      // as that would pick up system events instead of the actual response
      logger.warn(`${levelPrefix} No text content found in JSONL stream`);
      return { success: false, error: 'No text content found in response' };

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
   * Test if Claude CLI is available
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    try {
      const result = await this.execute('Respond with just: {"status": "ok"}', { timeout: 10000 });
      return result.status === 'ok' || result.raw?.includes('ok');
    } catch (error) {
      logger.warn(`Claude CLI not available: ${error.message}`);
      return false;
    }
  }

  static getProviderName() {
    return 'Claude';
  }

  static getProviderId() {
    return 'claude';
  }

  static getModels() {
    return CLAUDE_MODELS;
  }

  static getDefaultModel() {
    return 'sonnet';
  }

  static getInstallInstructions() {
    return 'Install Claude CLI: npm install -g @anthropic-ai/claude-code';
  }
}

// Register this provider
registerProvider('claude', ClaudeProvider);

module.exports = ClaudeProvider;
