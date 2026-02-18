// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Claude AI Provider
 *
 * Wraps the Claude CLI for use with the AI provider abstraction.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider, quoteShellArgs } = require('./provider');
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
    name: 'Haiku 4.5',
    tier: 'fast',
    tagline: 'Lightning Fast',
    description: 'Quick analysis for simple changes',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'sonnet',
    name: 'Sonnet 4.5',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Recommended for most reviews',
    badge: 'Standard',
    badgeClass: 'badge-recommended'
  },
  {
    id: 'opus-4.5',
    cli_model: 'claude-opus-4-5-20251101',
    name: 'Opus 4.5',
    tier: 'balanced',
    tagline: 'Deep Thinker',
    description: 'Extended thinking for complex analysis',
    badge: 'Previous Gen',
    badgeClass: 'badge-power'
  },
  {
    id: 'opus-4.6-low',
    cli_model: 'opus',
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    name: 'Opus 4.6 Low',
    tier: 'balanced',
    tagline: 'Fast Opus',
    description: 'Opus 4.6 with low effort — quick and capable',
    badge: 'Balanced',
    badgeClass: 'badge-recommended'
  },
  {
    id: 'opus-4.6-medium',
    cli_model: 'opus',
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' },
    name: 'Opus 4.6 Medium',
    tier: 'balanced',
    tagline: 'Balanced Opus',
    description: 'Opus 4.6 with medium effort — balanced depth',
    badge: 'Thorough',
    badgeClass: 'badge-power'
  },
  {
    id: 'opus',
    aliases: ['opus-4.6-high'],
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
    name: 'Opus 4.6 High',
    tier: 'thorough',
    tagline: 'Maximum Depth',
    description: 'Opus 4.6 with high effort — deepest analysis',
    badge: 'Most Thorough',
    badgeClass: 'badge-power',
    default: true
  },
  {
    id: 'opus-4.6-1m',
    cli_model: 'opus[1m]',
    name: 'Opus 4.6 1M',
    tier: 'balanced',
    tagline: 'Extended Context',
    description: 'Opus 4.6 high effort with 1M token context window',
    badge: 'More Context',
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
  constructor(model = 'opus', configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_CLAUDE_CMD;
    const configCmd = configOverrides.command;
    const claudeCmd = envCmd || configCmd || 'claude';

    // Store for use in getExtractionConfig, buildArgsForModel, and testAvailability
    this.claudeCmd = claudeCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands like "devx claude", use shell mode
    this.useShell = claudeCmd.includes(' ');

    // Check for budget limit environment variable
    const maxBudget = process.env.PAIR_REVIEW_MAX_BUDGET_USD;

    // Resolve model config using shared helper
    const { builtIn, configModel, cliModelArgs, extraArgs, env } = this._resolveModelConfig(model);

    // Build args: base args + provider extra_args + model extra_args
    // Use --output-format stream-json for JSONL streaming output (better debugging visibility)
    //
    // IMPORTANT: --verbose is MANDATORY when combining --output-format stream-json with -p (print mode).
    // Without --verbose, the stream-json output is incomplete or malformed in print mode.
    // This is a known requirement of the Claude CLI - do not remove --verbose from these args.
    let permissionArgs;
    if (configOverrides.yolo) {
      // In yolo mode, skip all fine-grained tool permissions
      permissionArgs = ['--dangerously-skip-permissions'];
    } else {
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
        'Bash(git sparse-checkout*)',
        'Bash(*git-diff-lines*)',
        'Bash(cat *)',
        'Bash(ls *)',
        'Bash(head *)',
        'Bash(tail *)',
        'Bash(grep *)',
        'Bash(find *)',
        'Bash(rg *)',
      ].join(',');
      permissionArgs = ['--allowedTools', allowedTools, '--permission-mode', 'dontAsk'];
    }
    const baseArgs = ['-p', '--verbose', ...cliModelArgs, '--output-format', 'stream-json', ...permissionArgs];
    if (maxBudget) {
      const budgetNum = parseFloat(maxBudget);
      if (isNaN(budgetNum) || budgetNum <= 0) {
        logger.warn(`Warning: PAIR_REVIEW_MAX_BUDGET_USD="${maxBudget}" is not a valid positive number, ignoring`);
      } else {
        baseArgs.push('--max-budget-usd', String(budgetNum));
      }
    }

    // Three-way merge for env: built-in model → provider config → per-model config
    this.extraEnv = env;

    if (this.useShell) {
      const allArgs = [...baseArgs, ...extraArgs];
      this.command = `${claudeCmd} ${quoteShellArgs(allArgs).join(' ')}`;
      this.args = [];
    } else {
      this.command = claudeCmd;
      this.args = [...baseArgs, ...extraArgs];
    }
  }

  /**
   * Resolve model configuration by looking up built-in and config override definitions.
   * Consolidates the CLAUDE_MODELS.find() and configOverrides.models.find() lookups
   * used across the constructor, buildArgsForModel(), and getExtractionConfig().
   *
   * @param {string} modelId - The model identifier to resolve
   * @returns {Object} Resolved configuration
   * @returns {Object|undefined} .builtIn - Built-in model definition from CLAUDE_MODELS
   * @returns {Object|undefined} .configModel - Config override model definition
   * @returns {string[]} .cliModelArgs - Args array for --model (empty if suppressed)
   * @returns {string[]} .extraArgs - Merged extra_args from built-in, provider, and config model
   * @returns {Object} .env - Merged env from built-in, provider, and config model
   * @private
   */
  _resolveModelConfig(modelId) {
    const configOverrides = this.configOverrides || {};

    // Resolve cli_model: config model > built-in model > id
    // cli_model decouples the app-level model ID from the CLI --model argument.
    // - undefined: fall through the resolution chain
    // - string: use this exact value for --model
    // - null: explicitly suppress --model (for tools that want the model set via env instead)
    const builtIn = CLAUDE_MODELS.find(m => m.id === modelId || (m.aliases && m.aliases.includes(modelId)));
    const configModel = configOverrides.models?.find(m => m.id === modelId);
    const resolvedCliModel = configModel?.cli_model !== undefined
      ? configModel.cli_model
      : (builtIn?.cli_model !== undefined ? builtIn.cli_model : modelId);

    // Conditionally include --model in base args (null = suppress, empty string passes through to surface CLI error)
    const cliModelArgs = resolvedCliModel !== null ? ['--model', resolvedCliModel] : [];

    // Three-way merge for extra_args: built-in model → provider config → per-model config
    const builtInArgs = builtIn?.extra_args || [];
    const providerArgs = configOverrides.extra_args || [];
    const configModelArgs = configModel?.extra_args || [];
    const extraArgs = [...builtInArgs, ...providerArgs, ...configModelArgs];

    // Three-way merge for env: built-in model → provider config → per-model config
    const env = {
      ...(builtIn?.env || {}),
      ...(configOverrides.env || {}),
      ...(configModel?.env || {})
    };

    return { builtIn, configModel, cliModelArgs, extraArgs, env };
  }

  /**
   * Execute Claude CLI with a prompt
   * @param {string} prompt - The prompt to send to Claude
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent, logPrefix, skipJsonExtraction = false } = options;

      const levelPrefix = logPrefix || `[Level ${level}]`;
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
        const parsed = this.parseClaudeResponse(stdout, level, levelPrefix);

        // If skipJsonExtraction is set, return raw text content directly (used for chat)
        if (skipJsonExtraction) {
          const textContent = parsed.textContent || stdout;
          logger.info(`${levelPrefix} Skipping JSON extraction, returning raw text (${textContent.length} chars)`);
          settle(resolve, { raw: textContent, parsed: false });
          return;
        }

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
          // Pass extracted text content to LLM fallback (not raw JSONL stdout).
          // The text content is the actual LLM response text extracted from JSONL
          // events and is much smaller and more relevant than the full JSONL stream.
          const llmFallbackInput = parsed.textContent || stdout;
          logger.info(`${levelPrefix} LLM fallback input length: ${llmFallbackInput.length} characters (${parsed.textContent ? 'text content' : 'raw stdout'})`);
          logger.info(`${levelPrefix} Attempting LLM-based JSON extraction fallback...`);

          // Use async IIFE to handle the async LLM extraction
          (async () => {
            try {
              const llmExtracted = await this.extractJSONWithLLM(llmFallbackInput, { level, analysisId, registerProcess, logPrefix: levelPrefix });
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
      claude.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Claude CLI not found. Please ensure Claude CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Claude CLI not found. ${ClaudeProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Claude process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      claude.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
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
    const { cliModelArgs, extraArgs } = this._resolveModelConfig(model);

    // Base args for extraction (simple prompt mode, no tools needed)
    const baseArgs = ['-p', ...cliModelArgs];

    return [...baseArgs, ...extraArgs];
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

    // Single call to _resolveModelConfig for both args and env
    const { cliModelArgs, extraArgs, env } = this._resolveModelConfig(model);
    const args = ['-p', ...cliModelArgs, ...extraArgs];

    if (useShell) {
      const quotedArgs = quoteShellArgs(args);
      return {
        command: `${claudeCmd} ${quotedArgs.join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true,
        env
      };
    }
    return {
      command: claudeCmd,
      args,
      useShell: false,
      promptViaStdin: true,
      env
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
  parseClaudeResponse(stdout, level, logPrefix) {
    const levelPrefix = logPrefix || `[Level ${level}]`;

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

        // If no JSON found, return with textContent so the caller can
        // pass it (not raw JSONL stdout) to the LLM extraction fallback
        logger.warn(`${levelPrefix} Text content is not JSON, treating as raw text`);
        return { success: false, error: 'Text content is not valid JSON', textContent };
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
   * Uses fast `--version` check instead of running a prompt.
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.claudeCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.claudeCmd} --version` : this.claudeCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Claude availability check: ${fullCmd}`);

      const claude = spawn(command, args, {
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
        logger.warn('Claude CLI availability check timed out after 10s');
        try { claude.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 10000);

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claude.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`Claude CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          const stderrMsg = stderr.trim() ? `: ${stderr.trim()}` : '';
          logger.warn(`Claude CLI not available or returned unexpected output (exit code ${code})${stderrMsg}`);
          resolve(false);
        }
      });

      claude.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Claude CLI not available: ${error.message}`);
        resolve(false);
      });
    });
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
    return 'opus';
  }

  static getInstallInstructions() {
    return 'Install Claude CLI: npm install -g @anthropic-ai/claude-code';
  }
}

// Register this provider
registerProvider('claude', ClaudeProvider);

module.exports = ClaudeProvider;
