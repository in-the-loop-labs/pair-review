// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pi AI Provider
 *
 * Implements the AI provider interface for the Pi coding agent CLI.
 * Uses `pi -p --mode json` for non-interactive execution with structured output.
 *
 * Pi outputs JSONL with event types: session, turn_start, message_start,
 * message_update, message_end, tool_execution_start/update/end, etc.
 * Text content is extracted from message_end events which contain the
 * complete assistant message with content blocks.
 *
 * Pi provides built-in analysis modes (default, multi-model) and supports
 * additional models via config.providers.pi.models in ~/.pair-review/config.json.
 * User-configured models can use `provider/model` format (e.g., 'google/gemini-2.5-flash')
 * for cross-provider switching, which translates to `--provider <provider> --model <model>`.
 */

const path = require('path');
const { spawn } = require('child_process');
const { AIProvider, registerProvider } = require('./provider');
const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');
const { CancellationError, isAnalysisCancelled } = require('../routes/shared');
const { StreamParser, parsePiLine, createPiLineParser } = require('./stream-parser');

// Directory containing bin scripts (git-diff-lines, etc.)
const BIN_DIR = path.join(__dirname, '..', '..', 'bin');

// Path to the bundled Pi task extension, which provides a generic subagent tool
// for delegating work to isolated pi subprocesses during analysis
const TASK_EXTENSION_DIR = path.join(__dirname, '..', '..', '.pi', 'extensions', 'task');

// Path to the review model guidance skill, which teaches Pi to select
// appropriate models for different review tasks (bug finding, security, etc.)
const REVIEW_SKILL_PATH = path.join(__dirname, '..', '..', '.pi', 'skills', 'review-model-guidance', 'SKILL.md');

/**
 * Pi model definitions
 *
 * Pi delegates model selection to the user's Pi configuration (~/.pi/).
 * These entries define analysis modes rather than specific models:
 * - 'default' uses whatever model the user has configured as their Pi default
 * - 'multi-model' loads the review guidance skill, teaching Pi to autonomously
 *    switch between models for different review tasks
 *
 * Users can also add specific models via config.json providers.pi.models.
 * Use `provider/model` format in cli_model for cross-provider switching
 * (e.g., 'google/gemini-2.5-flash' becomes --provider google --model gemini-2.5-flash).
 */
const PI_MODELS = [
  {
    id: 'default',
    cli_model: null,
    name: 'Default',
    tier: 'balanced',
    tagline: 'Your Pi Default',
    description: 'Uses your configured Pi default model',
    badge: 'Default',
    badgeClass: 'badge-recommended',
    default: true
  },
  {
    id: 'multi-model',
    cli_model: null,
    name: 'Multi-Model',
    tier: 'thorough',
    tagline: 'Smart Routing',
    description: 'Pi autonomously selects the best model for each review task',
    badge: 'Smart Routing',
    badgeClass: 'badge-power',
    extra_args: ['--skill', REVIEW_SKILL_PATH]
  }
];

/**
 * Extract text from assistant content, handling both array-of-blocks and
 * string content. Uses a Set for dedup to avoid incorrect substring matching.
 *
 * @param {Array|string} content - Content from an assistant message
 * @param {Set<string>} seenTexts - Set tracking already-seen text blocks
 * @returns {string} Extracted text (may be empty if all blocks were duplicates)
 */
function extractAssistantText(content, seenTexts) {
  let text = '';
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        if (!seenTexts.has(block.text)) {
          seenTexts.add(block.text);
          text += block.text;
        }
      }
    }
  } else if (typeof content === 'string') {
    if (!seenTexts.has(content)) {
      seenTexts.add(content);
      text += content;
    }
  }
  return text;
}

class PiProvider extends AIProvider {
  /**
   * @param {string|null} [model='default'] - Model identifier or null/undefined for default mode
   * @param {Object} configOverrides - Config overrides from providers config
   * @param {string} configOverrides.command - Custom CLI command
   * @param {string[]} configOverrides.extra_args - Additional CLI arguments
   * @param {Object} configOverrides.env - Additional environment variables
   * @param {Object[]} configOverrides.models - Custom model definitions
   */
  constructor(model, configOverrides = {}) {
    super(model || 'default');

    // Store config overrides early so _resolveCliModelArgs can use them
    this.configOverrides = configOverrides;

    // Resolve model configuration from built-in definitions and config overrides
    const resolvedModel = model || 'default';
    const builtIn = PI_MODELS.find(m => m.id === resolvedModel);
    const configModel = configOverrides.models?.find(m => m.id === resolvedModel);

    // Conditionally include --model (null = suppress, let Pi use its default)
    const cliModelArgs = this._resolveCliModelArgs(resolvedModel);

    // Command precedence: ENV > config > default
    const envCmd = process.env.PAIR_REVIEW_PI_CMD;
    const configCmd = configOverrides.command;
    const piCmd = envCmd || configCmd || 'pi';

    // For multi-word commands, use shell mode
    this.useShell = piCmd.includes(' ');

    // ============================================================================
    // SECURITY: Pi CLI tool permissions
    // ============================================================================
    //
    // Pi's --tools flag controls which built-in tools are available to the model.
    // When --tools is specified, ONLY the listed tools are loaded; unlisted tools
    // (edit, write) are not available at all — they cannot be requested or executed.
    //
    // Enabled tools: read, bash, grep, find, ls
    // Excluded tools: edit, write (file modification)
    //
    // Task extension: The `task` tool is loaded via `-e` as a Pi extension,
    // not via --tools. Subtasks spawned by the extension inherit the same
    // tool restrictions from the parent process environment.
    //
    // LIMITATION: The `bash` tool grants arbitrary shell command execution.
    // Unlike Claude (Bash(git diff*) prefixes) or Copilot (shell(git diff) prefixes),
    // Pi does not support fine-grained bash command restrictions. The model could
    // theoretically execute destructive commands (rm, git push, etc.).
    //
    // MITIGATION STRATEGY:
    // 1. Prompt engineering: Analysis prompts explicitly instruct the AI to only
    //    use read-only operations and never modify files
    // 2. Worktree isolation: Analysis runs in a git worktree, limiting blast radius
    // 3. Tool exclusion: edit and write tools are not loaded at all
    //
    // If Pi CLI adds prefix-based bash restrictions in the future, they should
    // be adopted here to match the granularity of other providers.
    // ============================================================================

    // pi -p --mode json --model <model> --tools read,bash,grep,find,ls <prompt-via-stdin>
    // -p: Non-interactive mode (process prompt and exit)
    // --mode json: Output JSONL events
    // --model: Specify the model (omitted when cli_model is null to use Pi's default)
    // --tools: Enable read-only tools for Level 2/3 analysis (excludes edit,write for safety).
    //          The task extension is loaded separately via `-e` (not part of --tools).
    // --no-session: Each pi invocation is an ephemeral analysis — there's no need to
    //               persist session state between runs. Set PAIR_REVIEW_PI_SESSION=1
    //               to enable session saving for debugging (sessions saved to ~/.pi/sessions/).
    // --no-skills: Skills are disabled by default to keep runs deterministic. A skill can
    //              still be loaded via `--skill` in model-specific `extra_args` if needed.

    // Build args: base args + built-in extra_args + provider extra_args + model extra_args
    // In yolo mode, omit --tools entirely to allow all tools (including edit, write)
    // The task extension is loaded to give the model a subagent tool for delegating
    // work to isolated subprocesses, preserving the main context window.
    // --no-extensions prevents auto-discovery of other extensions.
    // --no-skills and --no-prompt-templates keep the subprocess focused.
    const sessionArgs = process.env.PAIR_REVIEW_PI_SESSION ? [] : ['--no-session'];
    let baseArgs;
    if (configOverrides.yolo) {
      baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, ...sessionArgs,
        '--no-extensions', '--no-skills', '--no-prompt-templates',
        '-e', TASK_EXTENSION_DIR];
    } else {
      baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, '--tools', 'read,bash,grep,find,ls', ...sessionArgs,
        '--no-extensions', '--no-skills', '--no-prompt-templates',
        '-e', TASK_EXTENSION_DIR];
    }
    const builtInArgs = builtIn?.extra_args || [];
    const providerArgs = configOverrides.extra_args || [];
    const modelArgs = configModel?.extra_args || [];

    // Merge env: provider env + model env
    // PI_CMD tells the task extension how to invoke pi for subtasks.
    // This is essential when pi is invoked through a wrapper (e.g., 'devx pi --').
    this.extraEnv = {
      ...(configOverrides.env || {}),
      ...(configModel?.env || {}),
      PI_CMD: piCmd,
      // Limit subtask nesting to 1 level to prevent runaway recursive spawning
      // when the task extension delegates work to sub-agents.
      PI_TASK_MAX_DEPTH: '1',
    };

    // Store base command and args (prompt added in execute)
    this.piCmd = piCmd;
    this.baseArgs = [...baseArgs, ...builtInArgs, ...providerArgs, ...modelArgs];

    // configOverrides already stored at top of constructor for _resolveCliModelArgs
  }

  /**
   * Execute Pi CLI with a prompt
   * @param {string} prompt - The prompt to send to Pi
   * @param {Object} options - Optional configuration
   * @returns {Promise<Object>} Parsed response or error
   */
  async execute(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess, onStreamEvent } = options;

      const levelPrefix = `[Level ${level}]`;
      logger.info(`${levelPrefix} Executing Pi CLI...`);
      logger.info(`${levelPrefix} Writing prompt via stdin: ${prompt.length} bytes`);

      // Use stdin for prompt instead of CLI argument (avoids shell escaping issues)
      // Pi reads from stdin when using -p with no positional message arguments
      let fullCommand;
      let fullArgs;

      if (this.useShell) {
        fullCommand = `${this.piCmd} ${this.baseArgs.join(' ')}`;
        fullArgs = [];
      } else {
        fullCommand = this.piCmd;
        fullArgs = [...this.baseArgs];
      }

      const pi = spawn(fullCommand, fullArgs, {
        cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: this.useShell
      });

      const pid = pi.pid;
      logger.debug(`${levelPrefix} Pi CLI command: ${fullCommand} ${fullArgs.join(' ')}`);
      logger.info(`${levelPrefix} Spawned Pi CLI process: PID ${pid}`);

      // Register process for cancellation tracking if analysisId provided
      if (analysisId && registerProcess) {
        registerProcess(analysisId, pi);
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

      // Set up side-channel stream parser for live progress events.
      // Use the buffered Pi line parser to accumulate text_delta fragments
      // before emitting, preventing the UI from being flooded with tiny updates.
      const streamParser = onStreamEvent
        ? new StreamParser(createPiLineParser(), onStreamEvent, { cwd })
        : null;

      // Set timeout
      if (timeout) {
        timeoutId = setTimeout(() => {
          logger.error(`${levelPrefix} Process ${pid} timed out after ${timeout}ms`);
          pi.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Pi CLI timed out after ${timeout}ms`));
        }, timeout);
      }

      // Stream and log JSONL lines as they arrive for debugging visibility
      pi.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        // Feed side-channel stream parser for live progress events
        if (streamParser) {
          streamParser.feed(chunk);
        }

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
      pi.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      pi.on('close', (code) => {
        if (settled) return;  // Already settled by timeout or error

        // Flush any remaining stream parser buffer
        if (streamParser) {
          streamParser.flush();
        }

        // Check for cancellation signals (SIGTERM=143, SIGKILL=137)
        const isCancellationCode = code === 143 || code === 137;
        if (isCancellationCode && analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Pi CLI terminated due to analysis cancellation (exit code ${code})`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Also check for cancellation even with exit code 0 (Pi CLI may handle
        // SIGTERM gracefully and exit cleanly rather than with code 143)
        if (analysisId && isAnalysisCancelled(analysisId)) {
          logger.info(`${levelPrefix} Pi CLI exited with code ${code} but analysis was cancelled`);
          settle(reject, new CancellationError(`${levelPrefix} Analysis cancelled by user`));
          return;
        }

        // Always log stderr if present
        if (stderr.trim()) {
          if (code !== 0) {
            logger.error(`${levelPrefix} Pi CLI stderr (exit code ${code}): ${stderr}`);
          } else {
            logger.warn(`${levelPrefix} Pi CLI stderr (success): ${stderr}`);
          }
        }

        if (code !== 0) {
          logger.error(`${levelPrefix} Pi CLI exited with code ${code}`);
          settle(reject, new Error(`${levelPrefix} Pi CLI exited with code ${code}: ${stderr}`));
          return;
        }

        // Process any remaining buffered line
        if (lineBuffer.trim()) {
          lineCount++;
          this.logStreamLine(lineBuffer, lineCount, levelPrefix);
        }

        logger.info(`${levelPrefix} Pi CLI completed - received ${lineCount} JSONL events`);

        // Parse the Pi JSONL response
        const parsed = this.parsePiResponse(stdout, level);
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
            // Guard: if already settled (by timeout, stdin error, or cancellation),
            // skip the LLM extraction entirely to avoid misleading log output
            if (settled) return;

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
      pi.on('error', (error) => {
        if (error.code === 'ENOENT') {
          logger.error(`${levelPrefix} Pi CLI not found. Please ensure Pi CLI is installed.`);
          settle(reject, new Error(`${levelPrefix} Pi CLI not found. ${PiProvider.getInstallInstructions()}`));
        } else {
          logger.error(`${levelPrefix} Pi process error: ${error}`);
          settle(reject, error);
        }
      });

      // Handle stdin errors (e.g., EPIPE if process exits before write completes)
      pi.stdin.on('error', (err) => {
        logger.error(`${levelPrefix} stdin error: ${err.message}`);
      });

      // Send the prompt to stdin (Pi reads from stdin when using -p with no args)
      pi.stdin.write(prompt, (err) => {
        if (err) {
          logger.error(`${levelPrefix} Failed to write prompt to stdin: ${err}`);
          pi.kill('SIGTERM');
          settle(reject, new Error(`${levelPrefix} Failed to write prompt to stdin: ${err}`));
        }
      });
      pi.stdin.end();
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
        case 'session':
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Session started: ${event.id || 'unknown'}`);
          break;

        case 'turn_start':
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Turn started`);
          break;

        case 'turn_end': {
          const msg = event.message;
          if (msg?.role) {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] Turn ended (${msg.role})`);
          } else {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] Turn ended`);
          }
          break;
        }

        case 'message_start': {
          const msg = event.message;
          const role = msg?.role || 'unknown';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Message started (${role})`);
          break;
        }

        case 'message_update': {
          const assistantEvent = event.assistantMessageEvent;
          if (assistantEvent?.type === 'text_delta' && assistantEvent?.delta) {
            const preview = assistantEvent.delta.length > 60
              ? assistantEvent.delta.substring(0, 60) + '...'
              : assistantEvent.delta;
            logger.streamDebug(`${levelPrefix} [#${lineNum}] text_delta: ${preview.replace(/\n/g, '\\n')}`);
          } else if (assistantEvent?.type) {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] message_update: ${assistantEvent.type}`);
          } else {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] message_update`);
          }
          break;
        }

        case 'message_end': {
          const msg = event.message;
          const role = msg?.role || 'unknown';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Message ended (${role})`);
          break;
        }

        case 'tool_execution_start': {
          const toolName = event.toolName || 'unknown';
          const toolId = event.toolCallId || '';
          const idPart = toolId ? ` [${toolId.substring(0, 8)}]` : '';

          let inputPreview = '';
          const args = event.args;
          if (args) {
            if (typeof args === 'string') {
              inputPreview = args.length > 60 ? args.substring(0, 60) + '...' : args;
            } else if (typeof args === 'object') {
              if (args.command) {
                inputPreview = `cmd="${args.command.substring(0, 50)}${args.command.length > 50 ? '...' : ''}"`;
              } else if (args.file_path || args.path) {
                inputPreview = `path="${args.file_path || args.path}"`;
              } else {
                const keys = Object.keys(args);
                inputPreview = `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}}`;
              }
            }
          }

          const inputPart = inputPreview ? ` ${inputPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_start: ${toolName}${idPart}${inputPart}`);
          break;
        }

        case 'tool_execution_update': {
          const partial = event.partialResult || '';
          if (partial) {
            const preview = typeof partial === 'string'
              ? (partial.length > 60 ? partial.substring(0, 60) + '...' : partial)
              : JSON.stringify(partial).substring(0, 60);
            logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_update: ${preview.replace(/\n/g, '\\n')}`);
          } else {
            logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_update`);
          }
          break;
        }

        case 'tool_execution_end': {
          const isError = event.isError || false;
          const statusPart = isError ? ' ERROR' : ' OK';
          const result = event.result || '';
          let resultPreview = '';
          if (typeof result === 'string' && result.length > 0) {
            resultPreview = result.length > 60 ? result.substring(0, 60) + '...' : result;
            resultPreview = resultPreview.replace(/\n/g, '\\n');
          }
          const previewPart = resultPreview ? ` ${resultPreview}` : '';
          logger.streamDebug(`${levelPrefix} [#${lineNum}] tool_end${statusPart}${previewPart}`);
          break;
        }

        case 'agent_start':
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Agent started`);
          break;

        case 'agent_end':
          logger.streamDebug(`${levelPrefix} [#${lineNum}] Agent ended`);
          break;

        default:
          logger.streamDebug(`${levelPrefix} [#${lineNum}] ${type}`);
      }
    } catch {
      // If we can't parse the line, log the full content for debugging
      logger.streamDebug(`${levelPrefix} [#${lineNum}] (unparseable): ${line}`);
    }
  }

  /**
   * Parse Pi CLI JSONL response
   * Pi with --mode json outputs JSONL with structured events.
   * Text content is in message_end events with content blocks,
   * and in message_update events with text_delta.
   *
   * @param {string} stdout - Raw stdout from Pi CLI (JSONL format)
   * @param {string|number} level - Analysis level for logging
   * @returns {{success: boolean, data?: Object, error?: string}}
   */
  parsePiResponse(stdout, level) {
    const levelPrefix = `[Level ${level}]`;

    try {
      // Split by newlines and parse each JSON line
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      let textContent = '';
      const seenTexts = new Set();

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Extract text from message_end events (complete assistant messages)
          // These contain the full message with content blocks
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            textContent += extractAssistantText(event.message.content, seenTexts);
          }

          // Also collect text from turn_end events which include the message
          // (dedup handled by the shared seenTexts Set)
          if (event.type === 'turn_end' && event.message?.role === 'assistant') {
            textContent += extractAssistantText(event.message.content, seenTexts);
          }

          // Fallback: agent_end events contain the full messages array
          if (event.type === 'agent_end' && Array.isArray(event.messages)) {
            for (const msg of event.messages) {
              if (msg.role === 'assistant') {
                textContent += extractAssistantText(msg.content, seenTexts);
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
   * Resolve the --model (and optionally --provider) CLI arguments for a given model ID.
   * Checks config model overrides, then built-in definitions, then falls back to the raw ID.
   * Returns an empty array when cli_model is null (Pi uses its configured default).
   * Supports `provider/model` format (e.g., 'google/gemini-2.5-flash') which produces
   * ['--provider', 'google', '--model', 'gemini-2.5-flash'] for cross-provider switching.
   *
   * @param {string|null} modelId - Model identifier
   * @returns {string[]} CLI arguments (e.g., ['--model', 'x'], ['--provider', 'p', '--model', 'm'], or [])
   */
  _resolveCliModelArgs(modelId) {
    const builtIn = PI_MODELS.find(m => m.id === modelId);
    const configModel = this.configOverrides?.models?.find(m => m.id === modelId);
    const resolvedCliModel = configModel?.cli_model !== undefined
      ? configModel.cli_model
      : (builtIn?.cli_model !== undefined ? builtIn.cli_model : modelId);
    if (resolvedCliModel === null) return [];
    // Support provider/model format (e.g., 'google/gemini-2.5-flash')
    if (typeof resolvedCliModel === 'string' && resolvedCliModel.includes('/')) {
      const [provider, ...rest] = resolvedCliModel.split('/');
      return ['--provider', provider, '--model', rest.join('/')];
    }
    return ['--model', resolvedCliModel];
  }

  /**
   * Build args for Pi CLI execution, applying provider and model extra_args.
   * This ensures consistent arg construction for both execute() and getExtractionConfig().
   *
   * @param {string} model - The model identifier to use
   * @returns {string[]} Complete args array for the CLI
   */
  buildArgsForModel(model) {
    const cliModelArgs = this._resolveCliModelArgs(model);

    // Note: built-in extra_args (e.g., --skill for multi-model) are intentionally
    // excluded for extraction. Extraction is a simple JSON-parsing task that doesn't
    // need skills or other analysis-specific configuration.

    // Base args for pi non-interactive JSON mode (extraction only -- no tools needed)
    const sessionArgs = process.env.PAIR_REVIEW_PI_SESSION ? [] : ['--no-session'];
    const baseArgs = ['-p', '--mode', 'json', ...cliModelArgs, '--no-tools', ...sessionArgs];
    const configModel = this.configOverrides?.models?.find(m => m.id === model);
    const providerArgs = this.configOverrides?.extra_args || [];
    const modelArgs = configModel?.extra_args || [];
    return [...baseArgs, ...providerArgs, ...modelArgs];
  }

  /**
   * Get CLI configuration for LLM extraction
   * @param {string} model - The model to use for extraction
   * @returns {Object} Configuration for spawning extraction process
   */
  getExtractionConfig(model) {
    // Use the already-resolved command from the constructor (this.piCmd)
    // which respects: ENV > config > default precedence
    const piCmd = this.piCmd;
    const useShell = this.useShell;

    // Build args consistently using the shared method, applying provider and model extra_args
    const args = this.buildArgsForModel(model);

    // For extraction, we pass the prompt via stdin
    // Pi reads from stdin when using -p with no positional message arguments
    if (useShell) {
      return {
        command: `${piCmd} ${args.join(' ')}`,
        args: [],
        useShell: true,
        promptViaStdin: true,
        env: this.extraEnv
      };
    }
    return {
      command: piCmd,
      args,
      useShell: false,
      promptViaStdin: true,
      env: this.extraEnv
    };
  }

  /**
   * Test if Pi CLI is available
   * Uses the command configured in the instance (respects ENV > config > default precedence)
   * @returns {Promise<boolean>}
   */
  async testAvailability() {
    return new Promise((resolve) => {
      // For availability test, we just need to check --version
      // Use the already-resolved command from the constructor (this.piCmd)
      // which respects: ENV > config > default precedence
      const useShell = this.useShell;
      const command = useShell ? `${this.piCmd} --version` : this.piCmd;
      const args = useShell ? [] : ['--version'];

      // Log the actual command for debugging config/override issues
      const fullCmd = useShell ? command : `${command} ${args.join(' ')}`;
      logger.debug(`Pi availability check: ${fullCmd}`);

      const pi = spawn(command, args, {
        env: {
          ...process.env,
          ...this.extraEnv,
          PATH: `${BIN_DIR}:${process.env.PATH}`
        },
        shell: useShell
      });

      logger.debug(`Pi CLI spawn: ${command} ${args.join(' ')}`);

      let stdout = '';
      let settled = false;

      // Timeout guard: if the CLI hangs, resolve false
      const availabilityTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn('Pi CLI availability check timed out after 10s');
        try { pi.kill(); } catch { /* ignore */ }
        resolve(false);
      }, 10000);

      pi.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pi.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        if (code === 0) {
          logger.info(`Pi CLI available: ${stdout.trim()}`);
          resolve(true);
        } else {
          logger.warn('Pi CLI not available or returned unexpected output');
          resolve(false);
        }
      });

      pi.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(availabilityTimeout);
        logger.warn(`Pi CLI not available: ${error.message}`);
        resolve(false);
      });
    });
  }

  static getProviderName() {
    return 'Pi';
  }

  static getProviderId() {
    return 'pi';
  }

  static getModels() {
    return PI_MODELS;
  }

  static getDefaultModel() {
    const defaultModel = PI_MODELS.find(m => m.default);
    return defaultModel ? defaultModel.id : null;
  }

  static getInstallInstructions() {
    return 'Install Pi: npm install -g @mariozechner/pi-coding-agent\n' +
           'Or visit: https://github.com/badlogic/pi-mono';
  }
}

// Register this provider
registerProvider('pi', PiProvider);

module.exports = PiProvider;
module.exports._extractAssistantText = extractAssistantText;
