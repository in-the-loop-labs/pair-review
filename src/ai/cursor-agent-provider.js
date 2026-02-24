// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cursor Agent AI Provider
 *
 * Implements the AI provider interface for Cursor's Agent CLI.
 * Uses the `agent -p` command for non-interactive execution with
 * `--output-format stream-json` for JSONL streaming output.
 *
 * Agent stream-json event types:
 * - system (subtype: init): Session initialization with model info
 * - user: User message echo
 * - assistant: Assistant text responses (content blocks with type/text)
 * - tool_call (subtype: started|completed): Tool invocations with call_id
 * - result (subtype: success|error): Final result with duration_ms and result text
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider, quoteShellArgs } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parseCursorAgentLine } = require('./stream-parser');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

/**
 * Cursor Agent model definitions with tier mappings
 *
 * Tier structure:
 * - free (auto): Cursor's default auto-routing model
 * - fast (composer-1, gpt-5.3-codex-fast, gemini-3-flash): Quick analysis
 * - balanced (composer-1.5, sonnet-4.6-thinking, sonnet-4.5-thinking, gemini-3-pro, gemini-3.1-pro): Recommended for most reviews
 * - thorough (gpt-5.3-codex-high, gpt-5.3-codex-xhigh, opus-4.5-thinking, opus-4.6-thinking): Deep analysis for complex code
 */
const CURSOR_AGENT_MODELS = [
  {
    id: 'auto',
    name: 'Auto',
    tier: 'free',
    tagline: 'Cursor Auto-Routed',
    description: 'Cursor picks the best model automatically',
    badge: 'Free Tier',
    badgeClass: 'badge-speed'
  },
  {
    id: 'composer-1.5',
    name: 'Composer 1.5',
    tier: 'balanced',
    tagline: 'Latest Composer',
    description: 'Cursor Composer model—positioned between Sonnet and Opus for multi-file edits',
    badge: 'Balanced',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'composer-1',
    name: 'Composer 1',
    tier: 'fast',
    tagline: 'Original Composer',
    description: 'Cursor Composer model—good for quick multi-file editing workflows',
    badge: 'Fast',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gpt-5.3-codex-fast',
    name: 'GPT-5.3 Codex Fast',
    tier: 'fast',
    tagline: 'Lightning Fast',
    description: 'Latest code-specialized model optimized for speed—quick scans for obvious issues',
    badge: 'Fastest',
    badgeClass: 'badge-speed'
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    tier: 'fast',
    tagline: 'Fast & Capable',
    description: 'High SWE-bench scores at a fraction of the cost—great for quick reviews',
    badge: 'Fast',
    badgeClass: 'badge-speed'
  },
  {
    id: 'sonnet-4.6-thinking',
    name: 'Claude 4.6 Sonnet (Thinking)',
    tier: 'balanced',
    tagline: 'Best Balance',
    description: 'Latest Sonnet with extended thinking—excellent quality-to-cost ratio for thorough reviews',
    badge: 'Recommended',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'sonnet-4.5-thinking',
    name: 'Claude 4.5 Sonnet (Thinking)',
    tier: 'balanced',
    tagline: 'Previous Gen',
    description: 'Previous generation extended thinking—still strong for thorough analysis',
    badge: 'Previous Gen',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gemini-3-pro',
    name: 'Gemini 3 Pro',
    tier: 'balanced',
    tagline: 'Strong Alternative',
    description: "Google's flagship model for code review—strong agentic and vibe coding capabilities",
    badge: 'Balanced',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    tier: 'balanced',
    tagline: 'Latest Gemini',
    description: 'Newest Gemini model—cutting-edge reasoning for complex multi-file reviews',
    badge: 'Latest',
    badgeClass: 'badge-balanced'
  },
  {
    id: 'gpt-5.3-codex-high',
    name: 'GPT-5.3 Codex High',
    tier: 'thorough',
    tagline: 'Deep Code Analysis',
    description: "OpenAI's latest and most capable for complex code review with deep reasoning",
    badge: 'Thorough',
    badgeClass: 'badge-power'
  },
  {
    id: 'gpt-5.3-codex-xhigh',
    name: 'GPT-5.3 Codex Extra High',
    tier: 'thorough',
    tagline: 'Maximum Reasoning',
    description: 'Highest reasoning effort for the most complex architectural reviews',
    badge: 'Maximum',
    badgeClass: 'badge-power'
  },
  {
    id: 'opus-4.5-thinking',
    name: 'Claude 4.5 Opus (Thinking)',
    tier: 'thorough',
    tagline: 'Deep Analysis',
    description: 'Deep analysis with extended thinking for complex code reviews',
    badge: 'Thorough',
    badgeClass: 'badge-power'
  },
  {
    id: 'opus-4.6-thinking',
    name: 'Claude 4.6 Opus (Thinking)',
    tier: 'thorough',
    tagline: 'Most Capable',
    description: 'Deep analysis with extended thinking—Cursor default for maximum review quality',
    badge: 'Most Thorough',
    badgeClass: 'badge-power'
  }
];

const DEFAULT_CURSOR_AGENT_MODEL = 'sonnet-4.6-thinking';

class CursorAgentProvider extends AIProvider {
  /**
   * @param {string} model - Model identifier
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model = DEFAULT_CURSOR_AGENT_MODEL, configOverrides = {}) {
    super(model);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_CURSOR_AGENT_CMD;
    const configCmd = configOverrides.command;
    const agentCmd = envCmd || configCmd || 'agent';

    // Store for use in getExtractionConfig and testAvailability
    this.agentCmd = agentCmd;
    this.configOverrides = configOverrides;

    // For multi-word commands, use shell mode (same pattern as other providers)
    this.useShell = agentCmd.includes(' ');

    // ============================================================================
    // SECURITY LIMITATION - READ CAREFULLY
    // ============================================================================
    //
    // IMPORTANT: Cursor Agent CLI does NOT currently support fine-grained tool
    // permission controls (no --allowedTools, --allow-tool, or --deny-tool flags).
    //
    // The --sandbox flag controls sandbox mode but its exact behavior with tool
    // restrictions is undocumented. We enable sandbox mode as a precaution.
    //
    // MITIGATION STRATEGY:
    // 1. Prompt engineering: The analysis prompts explicitly instruct the AI to
    //    only use read-only operations and never modify files
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Sandbox mode: Enabled as an additional safety layer
    //
    // If a mechanism to restrict tool permissions becomes available in the Agent CLI,
    // it should be added here similar to Claude's --allowedTools or Copilot's
    // --allow-tool/--deny-tool flags.
    // ============================================================================

    // Build args: base args + provider extra_args + model extra_args
    // Use --output-format stream-json for JSONL streaming output
    // Use --stream-partial-output for real-time text deltas (better for progress display)
    //   NOTE: --stream-partial-output is tightly coupled to the delta-filtering logic
    //   in parseCursorAgentResponse (isStreamingDelta / timestamp_ms check). If this
    //   flag is removed, the parser will treat all assistant events as complete messages,
    //   which is fine but will change accumulation behavior. Keep these in sync.
    // Normal mode: --trust to auto-approve the working directory, --sandbox enabled for safety
    // Yolo mode: --yolo to skip all permissions (implies trust + sandbox disabled)
    const permissionArgs = configOverrides.yolo
      ? ['--yolo']
      : ['--trust', '--sandbox', 'enabled'];
    const baseArgs = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--model', model, ...permissionArgs];
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
      this.command = `${agentCmd} ${quoteShellArgs([...baseArgs, ...providerArgs, ...modelArgs]).join(' ')}`;
      this.args = [];
    } else {
      this.command = agentCmd;
      this.args = [...baseArgs, ...providerArgs, ...modelArgs];
    }
  }

  /**
   * Execute Cursor Agent CLI with a prompt
   * @param {string} prompt - The prompt to send to Cursor Agent
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent, logPrefix } = options;

      const levelPrefix = logPrefix || `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Cursor Agent CLI...`);
      logger.info(`${levelPrefix} Writing prompt: ${prompt.length} chars`);

      const agent = spawn(this.command, this.args, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = agent.pid;
      logger.info(`${levelPrefix} Spawned Cursor Agent CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, agent);
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
        ? new StreamParser(parseCursorAgentLine, onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          agent.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Cursor Agent CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Collect stdout with streaming JSONL parsing for debug visibility
      agent.stdout.on('data', (data) => {
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
      agent.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      agent.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Cursor Agent CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Cursor Agent CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Cursor Agent CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Cursor Agent CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Cursor Agent CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        // Log completion with event count (after lineBuffer flush for accurate count)
        logger.info(`${levelPrefix} Cursor Agent CLI completed: ${lineCount} JSONL events received`);

        // Parse the Cursor Agent JSONL stream response
        const parsed = this.parseCursorAgentResponse(stdout, level, levelPrefix);
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
              // Re-check settled before spawning LLM extraction to avoid
              // orphan processes if timeout fired between close-handler entry
              // and reaching this point.
              if (settled) return;
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
      agent.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Cursor Agent CLI not found. Please ensure Cursor Agent CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Cursor Agent CLI not found. ${CursorAgentProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Cursor Agent process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      agent.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Send the prompt to stdin
      agent.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          agent.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      agent.stdin.end();
    });
  }

  /**
   * Parse Cursor Agent CLI JSONL stream response
   *
   * Agent with --output-format stream-json outputs JSONL with:
   * - system (subtype: init): Session initialization with model info
   * - user: User message echo
   * - assistant: Text responses in content blocks [{type: "text", text: "..."}]
   *   With --stream-partial-output, multiple assistant events arrive as deltas.
   *   The last assistant event (no timestamp_ms) contains the complete accumulated text.
   * - tool_call (subtype: started|completed): Tool invocations
   * - result (subtype: success): Final result with 'result' text field
   *
   * We accumulate text from assistant messages and extract JSON from them.
   * The result event's 'result' field is used as fallback.
   *
   * @param {string} stdout - Raw stdout from Cursor Agent CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parseCursorAgentResponse(stdout, level, logPrefix) {
    const levelPrefix = logPrefix || `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      // Accumulate text from assistant messages.
      // With --stream-partial-output, the last assistant event (without timestamp_ms)
      // contains the complete accumulated text for that turn.
      // Without --stream-partial-output, each assistant event has complete content.
      let assistantText = '';
      let resultText = '';

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Collect text from assistant messages
          // With streaming, we get incremental deltas (with timestamp_ms)
          // followed by a final complete message (without timestamp_ms).
          // We only take the final complete message per turn to avoid duplication.
          if (event.type === 'assistant') {
            const content = event.message?.content || [];
            const isStreamingDelta = typeof event.timestamp_ms === 'number';

            if (!isStreamingDelta) {
              // This is a complete assistant message (final accumulation)
              // Replace any previous accumulated text from this turn
              let turnText = '';
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  turnText += block.text;
                }
              }
              if (turnText) {
                assistantText += turnText;
              }
            }
          }

          // Also capture the result event's text as fallback
          if (event.type === 'result' && event.result) {
            resultText = event.result;
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      // Primary: try to extract JSON from accumulated assistant text
      if (assistantText) {
        logger.debug(`${levelPrefix} Extracted ${assistantText.length} chars of assistant text from JSONL`);
        const extracted = extractJSON(assistantText, level);
        if (extracted.success) {
          return extracted;
        }

        logger.warn(`${levelPrefix} Assistant text is not JSON, trying result text fallback`);
      }

      // Fallback: try extracting JSON from the result event's text
      if (resultText) {
        logger.debug(`${levelPrefix} Trying result text: ${resultText.length} chars`);
        const extracted = extractJSON(resultText, level);
        if (extracted.success) {
          return extracted;
        }

        logger.warn(`${levelPrefix} Result text is not JSON either`);
      }

      // Last resort: try extracting JSON directly from raw stdout
      if (!assistantText && !resultText) {
        const extracted = extractJSON(stdout, level);
        return extracted;
      }

      // Include textContent so the caller can pass it to LLM extraction fallback
      const textContent = assistantText || resultText || null;
      return { success: false, error: 'No valid JSON found in assistant or result text', textContent };

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
   *
   * Cursor Agent stream-json format event types:
   * - system (subtype: init): Session initialization
   * - user: User message echo
   * - assistant: Text responses (may be streaming deltas with timestamp_ms)
   * - tool_call (subtype: started|completed): Tool invocations
   * - result (subtype: success): Final result with stats
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

      if (eventType === 'system') {
        if (!streamEnabled) return;
        const sessionId = event.session_id || '';
        const model = event.model || '';
        const subtype = event.subtype || '';
        const sessionPart = sessionId ? ` session=${sessionId.substring(0, 12)}` : '';
        const modelPart = model ? ` model=${model}` : '';
        const subtypePart = subtype ? ` (${subtype})` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] system${subtypePart}${sessionPart}${modelPart}`);

      } else if (eventType === 'user') {
        if (!streamEnabled) return;
        const content = event.message?.content || [];
        let textPreview = '';
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textPreview += block.text;
          }
        }
        if (textPreview) {
          const preview = textPreview.replace(/\n/g, '\\n').substring(0, 40);
          logger.streamDebug(`${levelPrefix} [#${lineNum}] user: ${preview}${textPreview.length > 40 ? '...' : ''}`);
        } else {
          logger.streamDebug(`${levelPrefix} [#${lineNum}] user`);
        }

      } else if (eventType === 'assistant') {
        if (!streamEnabled) return;
        const content = event.message?.content || [];
        const isStreamingDelta = typeof event.timestamp_ms === 'number';
        const deltaPart = isStreamingDelta ? ' (delta)' : '';

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const preview = block.text.replace(/\n/g, '\\n').substring(0, 60);
            logger.streamDebug(`${levelPrefix} [#${lineNum}] assistant${deltaPart}: ${preview}${block.text.length > 60 ? '...' : ''}`);
          }
        }

      } else if (eventType === 'tool_call') {
        if (!streamEnabled) return;
        const subtype = event.subtype || '';
        const callId = event.call_id || '';
        const toolCall = event.tool_call || {};

        // Extract tool name and details from the tool_call object
        // Agent format: { shellToolCall: { args: { command: "..." } } }
        // or similar structures for other tool types
        let toolName = 'unknown';
        let toolDetail = '';

        if (toolCall.shellToolCall) {
          toolName = 'shell';
          const cmd = toolCall.shellToolCall.args?.command || toolCall.shellToolCall.result?.rejected?.command || '';
          if (cmd) {
            toolDetail = `cmd="${cmd.substring(0, 50)}${cmd.length > 50 ? '...' : ''}"`;
          }
        } else if (toolCall.readToolCall) {
          toolName = 'read';
          const filePath = toolCall.readToolCall.args?.path || '';
          if (filePath) {
            toolDetail = `path="${filePath}"`;
          }
        } else if (toolCall.editToolCall) {
          toolName = 'edit';
          const filePath = toolCall.editToolCall.args?.path || '';
          if (filePath) {
            toolDetail = `path="${filePath}"`;
          }
        } else {
          // Try to identify the tool type from the keys
          const toolKeys = Object.keys(toolCall);
          if (toolKeys.length > 0) {
            toolName = toolKeys[0].replace('ToolCall', '');
          }
        }

        const idPart = callId ? ` [${callId.substring(0, 12)}]` : '';
        const subtypePart = subtype ? ` ${subtype}` : '';
        const detailPart = toolDetail ? ` ${toolDetail}` : '';
        logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_call${subtypePart}: ${toolName}${idPart}${detailPart}`);

      } else if (eventType === 'result') {
        // Final result - always log this at info level (not stream debug)
        const subtype = event.subtype || '';
        const durationMs = event.duration_ms || 0;
        const durationApiMs = event.duration_api_ms || 0;
        const isError = event.is_error || false;
        const resultText = event.result || '';

        const statusPart = isError ? ' ERROR' : ' OK';
        const durationPart = durationMs ? ` duration=${durationMs}ms` : '';
        const apiDurationPart = durationApiMs ? ` api=${durationApiMs}ms` : '';

        logger.info(`${levelPrefix} [result] ${subtype}${statusPart}${durationPart}${apiDurationPart}`);

        // Show a preview of the actual response content
        if (resultText) {
          const charCount = resultText.length;
          const preview = resultText.replace(/\s+/g, ' ').substring(0, 100);
          logger.info(`${levelPrefix} [response] ${charCount} chars: ${preview}${charCount > 100 ? '...' : ''}`);
        }

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
   * Build args for Cursor Agent CLI extraction, applying provider and model extra_args.
   * This ensures consistent arg construction for getExtractionConfig().
   *
   * Note: For extraction, we use text output (--output-format text) for simpler
   * JSON parsing. No sandbox needed since extraction doesn't use tools.
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    // Base args for extraction (text output, no tools needed)
    // --trust needed to auto-approve the working directory without interactive prompt
    const baseArgs = ['-p', '--output-format', 'text', '--trust', '--model', model];
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
    // Use the already-resolved command from the constructor (this.agentCmd)
    // which respects: ENV > config > default precedence
    const agentCmd = this.agentCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    // For extraction, we pass the prompt via stdin
    if (useShell) {
      return {
        command: `${agentCmd} ${quoteShellArgs(args).join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true
      };
    }
    return {
      command: agentCmd,
      args,
      useShell: false,
      promptViaStdin: true
    };
  }

  /**
   * Test if Cursor Agent CLI is available
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.agentCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.agentCmd} --version` : this.agentCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Cursor Agent availability check: ${fullCmd}`);

      const agent = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      let stdout = '';
      let settled = false;

      // Timeout guard: if the CLI hangs (e.g., waiting for auth), resolve false
      const availabilityTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn('Cursor Agent CLI availability check timed out after 10s');
        try { agent.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 10000);

      agent.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      agent.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`Cursor Agent CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Cursor Agent CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      agent.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Cursor Agent CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Cursor';
  }

  static getProviderId() {
    return 'cursor-agent';
  }

  static getModels() {
    return CURSOR_AGENT_MODELS;
  }

  static getDefaultModel() {
    return DEFAULT_CURSOR_AGENT_MODEL;
  }

  static getInstallInstructions() {
    return 'Install Cursor Agent CLI: https://cursor.com/docs/cli/using\n' +
           'Run "agent login" to authenticate after installation.';
  }
}

// Register this provider
registerProvider('cursor-agent', CursorAgentProvider);

module.exports = CursorAgentProvider;
