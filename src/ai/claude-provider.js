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

    // Build args: base args + provider extra_args + model extra_args
    // Use --output-format stream-json for JSONL streaming output (better debugging visibility)
    //
    // IMPORTANT: --verbose is MANDATORY when combining --output-format stream-json with -p (print mode).
    // Without --verbose, the stream-json output is incomplete or malformed in print mode.
    // This is a known requirement of the Claude CLI - do not remove --verbose from these args.
    const baseArgs = ['-p', '--verbose', '--model', model, '--output-format', 'stream-json', '--allowedTools', allowedTools];
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
      const { cwd = process.cwd(), timeout = 300000, level = 'unknown', analysisId, registerProcess } = options;

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
          logger.warn(`${levelPrefix} Failed to extract JSON: ${parsed.error}`);
          logger.info(`${levelPrefix} Raw response length: ${stdout.length} characters`);
          logger.info(`${levelPrefix} Raw response preview: ${stdout.substring(0, 500)}...`);
          settle(resolve, { raw: stdout, parsed: false });
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
   * Log a streaming JSONL line for debugging visibility
   * Claude stream-json format:
   * - stream_event with content_block_delta: text fragments
   * - assistant messages: tool calls and results
   * - result: final result with text content
   *
   * @param {string} line - A single JSONL line
   * @param {string} levelPrefix - Logging prefix
   */
  logStreamLine(line, levelPrefix) {
    try {
      const event = JSON.parse(line);
      const eventType = event.type;

      if (eventType === 'stream_event') {
        // Streaming text delta
        const delta = event.event?.delta;
        if (delta?.type === 'text_delta' && delta?.text) {
          // Log text fragments at debug level (can be very frequent)
          const preview = delta.text.replace(/\n/g, '\\n').substring(0, 80);
          logger.debug(`${levelPrefix} [text] ${preview}${delta.text.length > 80 ? '...' : ''}`);
        }
      } else if (eventType === 'assistant') {
        // Assistant turn with tool use or message
        // Dump full content for debugging
        logger.debug(`${levelPrefix} [assistant] ${JSON.stringify(event.message?.content || event, null, 2).substring(0, 2000)}`);
      } else if (eventType === 'user') {
        // Tool result - dump full content for debugging
        logger.debug(`${levelPrefix} [user] ${JSON.stringify(event.message?.content || event, null, 2).substring(0, 2000)}`);
      } else if (eventType === 'result') {
        // Final result - extract text content and show a preview
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
      } else if (eventType) {
        // Unknown event type - only log if we have an actual type
        logger.debug(`${levelPrefix} [${eventType}] event received`);
      }
      // Silently ignore events with no type
    } catch (parseError) {
      // Skip malformed lines
      logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
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

      // First pass: find the result event (authoritative source)
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            resultEvent = event;
            break; // Result is the final event, no need to continue
          }
        } catch (lineError) {
          // Skip malformed lines
          logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
        }
      }

      // Extract content from result event only (single authoritative source)
      // The result event contains the complete response - assistant messages and
      // stream_event deltas are intermediate views of the same content.
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
