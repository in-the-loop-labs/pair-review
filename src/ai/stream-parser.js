// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Stream Parser - Side-channel parser for real-time AI streaming events
 *
 * Reads stdout data incrementally from provider processes and emits normalized
 * events for display in the progress modal. This is a read-only side channel;
 * the existing stdout buffering and final JSON extraction remain untouched.
 *
 * Normalized event shape:
 *   { type: 'assistant_text' | 'tool_use', text: string, timestamp: number }
 */

const logger = require('../utils/logger');

/**
 * Collapse whitespace and truncate text for display as a snippet.
 * @param {string} text - Raw text to truncate
 * @param {number} maxLen - Maximum output length (default 200)
 * @returns {string} Collapsed and truncated text
 */
function truncateSnippet(text, maxLen = 200) {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.substring(0, maxLen) + '…';
}

/**
 * Strip a worktree/cwd prefix from a file path, returning a relative path.
 * If the path doesn't start with the prefix, returns the original path.
 * @param {string} filePath - Absolute file path
 * @param {string} cwdPrefix - Working directory prefix to strip
 * @returns {string} Relative path
 */
function stripPathPrefix(filePath, cwdPrefix) {
  if (!filePath || !cwdPrefix) return filePath || '';
  // Normalize: ensure prefix ends with /
  const normalized = cwdPrefix.endsWith('/') ? cwdPrefix : cwdPrefix + '/';
  if (filePath.startsWith(normalized)) {
    return filePath.substring(normalized.length);
  }
  // Exact match (filePath is the directory itself)
  if (filePath === cwdPrefix) {
    return '';
  }
  return filePath;
}

/**
 * Extract a human-readable detail string from tool input/arguments.
 * Shared across all provider-specific line parsers.
 *
 * Priority: command > description > file_path/filePath/path
 *
 * @param {Object|string|null} input - Tool input (object or JSON string)
 * @param {string} [cwd] - Working directory to strip from file paths
 * @returns {string} Detail string for display (may be empty)
 */
function extractToolDetail(input, cwd) {
  if (!input) return '';

  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { return input; }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return typeof parsed === 'string' ? parsed : '';
  }

  // Command execution (bash, shell, etc.)
  if (parsed.command) return parsed.command;

  // Task/agent description (Claude Code Task tool, Pi task extension, etc.)
  if (parsed.description) return parsed.description;
  if (parsed.task) return parsed.task;

  // File path (various field naming conventions)
  const rawPath = parsed.file_path || parsed.filePath || parsed.path;
  if (rawPath) return cwd ? stripPathPrefix(rawPath, cwd) : rawPath;

  return '';
}

/**
 * Parse a single Claude stream-json line into a normalized event.
 * Returns null if the line should not be emitted (e.g. tool_result, system, result).
 *
 * Claude stream-json event types:
 * - stream_event (content_block_delta with text_delta)
 * - assistant (message with tool_use / text content blocks)
 * - user (tool_result - filtered out)
 * - result (final summary - filtered out)
 * - system (filtered out)
 *
 * @param {string} line - A single JSONL line from Claude stdout
 * @param {Object} [options] - Parse options
 * @param {string} [options.cwd] - Working directory to strip from file paths
 * @returns {{ type: string, text: string, timestamp: number } | null}
 */
function parseClaudeLine(line, options = {}) {
  if (!line || !line.trim()) return null;

  const { cwd } = options;

  try {
    const event = JSON.parse(line);
    const eventType = event.type;

    if (eventType === 'stream_event') {
      const delta = event.event?.delta;
      if (delta?.type === 'text_delta' && delta?.text) {
        return {
          type: 'assistant_text',
          text: truncateSnippet(delta.text),
          timestamp: Date.now()
        };
      }
      return null;
    }

    if (eventType === 'assistant') {
      const content = event.message?.content || [];
      // Emit the first interesting block (priority: text > tool_use).
      // Text blocks represent the agent reasoning aloud and are generally
      // more informative than tool invocations for the human observer.
      let toolUseEvent = null;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          return {
            type: 'assistant_text',
            text: truncateSnippet(block.text),
            timestamp: Date.now()
          };
        }
        if (block.type === 'tool_use' && !toolUseEvent) {
          const toolName = block.name || 'unknown';
          const detail = extractToolDetail(block.input, cwd);
          const text = detail ? `${toolName}: ${detail}` : toolName;
          toolUseEvent = {
            type: 'tool_use',
            text: truncateSnippet(text),
            timestamp: Date.now()
          };
        }
      }
      return toolUseEvent;
    }

    // tool_result (user), result, system — never emit
    return null;
  } catch {
    // Best-effort side channel — silently ignore non-JSON or malformed lines.
    // The main stdout buffer handles authoritative response parsing.
    return null;
  }
}

/**
 * Parse a single Codex JSONL line into a normalized event.
 * Returns null if the line should not be emitted.
 *
 * Codex JSONL event types:
 * - item.completed with item.type === 'agent_message' → assistant_text
 * - item.completed with item.type === 'function_call' | 'tool_call' | 'tool_use' → tool_use
 * - item.completed with item.type === 'function_call_output' | 'tool_result' → filtered out
 * - thread.started, turn.started, turn.completed → filtered out
 *
 * @param {string} line - A single JSONL line from Codex stdout
 * @param {Object} [options] - Parse options
 * @param {string} [options.cwd] - Working directory to strip from file paths
 * @returns {{ type: string, text: string, timestamp: number } | null}
 */
function parseCodexLine(line, options = {}) {
  if (!line || !line.trim()) return null;

  const { cwd } = options;

  try {
    const event = JSON.parse(line);

    if (event.type !== 'item.completed') return null;

    const item = event.item || {};
    const itemType = item.type;

    if (itemType === 'agent_message' && item.text) {
      return {
        type: 'assistant_text',
        text: truncateSnippet(item.text),
        timestamp: Date.now()
      };
    }

    if (itemType === 'function_call' || itemType === 'tool_call' || itemType === 'tool_use') {
      const toolName = item.name || item.tool || 'unknown';
      const detail = extractToolDetail(item.arguments || item.input || item.args, cwd);
      const text = detail ? `${toolName}: ${detail}` : toolName;
      return {
        type: 'tool_use',
        text: truncateSnippet(text),
        timestamp: Date.now()
      };
    }

    // tool_result, reasoning, etc. — filtered out
    return null;
  } catch {
    // Best-effort side channel — silently ignore non-JSON or malformed lines.
    // The main stdout buffer handles authoritative response parsing.
    return null;
  }
}

/**
 * Parse a single Gemini stream-json JSONL line into a normalized event.
 * Returns null if the line should not be emitted.
 *
 * Gemini stream-json event types:
 * - message (role: "assistant") → assistant_text
 * - tool_use (tool_name, parameters) → tool_use
 * - init, message (role: "user"), tool_result, result → filtered out
 *
 * @param {string} line - A single JSONL line from Gemini stdout
 * @param {Object} [options] - Parse options
 * @param {string} [options.cwd] - Working directory to strip from file paths
 * @returns {{ type: string, text: string, timestamp: number } | null}
 */
function parseGeminiLine(line, options = {}) {
  if (!line || !line.trim()) return null;

  const { cwd } = options;

  try {
    const event = JSON.parse(line);
    const eventType = event.type;

    if (eventType === 'message' && event.role === 'assistant' && event.content && event.content.trim()) {
      return {
        type: 'assistant_text',
        text: truncateSnippet(event.content),
        timestamp: Date.now()
      };
    }

    if (eventType === 'tool_use') {
      const toolName = event.tool_name || 'unknown';
      const detail = extractToolDetail(event.parameters, cwd);
      const text = detail ? `${toolName}: ${detail}` : toolName;
      return {
        type: 'tool_use',
        text: truncateSnippet(text),
        timestamp: Date.now()
      };
    }

    // init, user messages, tool_result, result — never emit
    return null;
  } catch {
    // Best-effort side channel — silently ignore non-JSON or malformed lines.
    return null;
  }
}

/**
 * Parse a single OpenCode JSONL line into a normalized event.
 * Returns null if the line should not be emitted.
 *
 * OpenCode JSONL event types:
 * - text (part.text or event.text) → assistant_text
 * - tool_call / tool_use (part.tool, part.state.input) → tool_use
 * - step_start, step_finish, tool_result → filtered out
 *
 * @param {string} line - A single JSONL line from OpenCode stdout
 * @param {Object} [options] - Parse options
 * @param {string} [options.cwd] - Working directory to strip from file paths
 * @returns {{ type: string, text: string, timestamp: number } | null}
 */
function parseOpenCodeLine(line, options = {}) {
  if (!line || !line.trim()) return null;

  const { cwd } = options;

  try {
    const event = JSON.parse(line);
    const eventType = event.type;

    if (eventType === 'text') {
      const text = event.part?.text || event.text || '';
      if (text.trim()) {
        return {
          type: 'assistant_text',
          text: truncateSnippet(text),
          timestamp: Date.now()
        };
      }
      return null;
    }

    if (eventType === 'tool_call' || eventType === 'tool_use') {
      const part = event.part || {};
      const toolName = part.tool || part.name || part.tool_name || 'unknown';
      const detail = extractToolDetail(part.state?.input || part.input || part.arguments, cwd);
      const text = detail ? `${toolName}: ${detail}` : toolName;
      return {
        type: 'tool_use',
        text: truncateSnippet(text),
        timestamp: Date.now()
      };
    }

    // step_start, step_finish, tool_result — filtered out
    return null;
  } catch {
    // Best-effort side channel — silently ignore non-JSON or malformed lines.
    return null;
  }
}

/**
 * Line-buffered stream parser that handles partial lines across chunks.
 * Feeds data incrementally and calls onEvent for each parsed event.
 */
class StreamParser {
  /**
   * @param {Function} parseLine - Provider-specific line parser (e.g. parseClaudeLine, parseGeminiLine)
   * @param {Function} onEvent - Callback receiving normalized events { type, text, timestamp }
   * @param {Object} [options] - Options passed through to parseLine (e.g. { cwd })
   */
  constructor(parseLine, onEvent, options = {}) {
    this.parseLine = parseLine;
    this.onEvent = onEvent;
    this.options = options;
    this.buffer = '';
  }

  /**
   * Feed a chunk of stdout data. Complete lines are parsed immediately;
   * the last partial line is buffered for the next feed() call.
   * @param {string|Buffer} data - Raw stdout chunk
   */
  feed(data) {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    // Last element is either empty (if chunk ended with \n) or a partial line
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = this.parseLine(line, this.options);
      if (event) {
        try {
          this.onEvent(event);
        } catch (error) {
          // Don't let a callback error halt stream processing for the analysis
          logger.warn('[StreamParser] onEvent callback error: ' + error.message);
        }
      }
    }
  }

  /**
   * Flush remaining buffer (call on process close).
   * Processes any final partial line left in the buffer.
   */
  flush() {
    if (this.buffer.trim()) {
      const event = this.parseLine(this.buffer, this.options);
      if (event) {
        try {
          this.onEvent(event);
        } catch (error) {
          logger.warn('[StreamParser] onEvent callback error: ' + error.message);
        }
      }
    }
    this.buffer = '';
  }
}

/**
 * Parse a single Cursor Agent stream-json JSONL line into a normalized event.
 * Returns null if the line should not be emitted.
 *
 * Cursor Agent stream-json event types:
 * - system (subtype: init) → filtered out
 * - user → filtered out
 * - assistant (content blocks with type/text) → assistant_text
 *   With --stream-partial-output, streaming deltas have timestamp_ms;
 *   the final complete message does not. We emit both for real-time display.
 * - tool_call (subtype: started) → tool_use
 * - tool_call (subtype: completed) → filtered out
 * - result → filtered out
 *
 * @param {string} line - A single JSONL line from Cursor Agent stdout
 * @param {Object} [options] - Parse options
 * @param {string} [options.cwd] - Working directory to strip from file paths
 * @returns {{ type: string, text: string, timestamp: number } | null}
 */
function parseCursorAgentLine(line, options = {}) {
  if (!line || !line.trim()) return null;

  const { cwd } = options;

  try {
    const event = JSON.parse(line);
    const eventType = event.type;

    if (eventType === 'assistant') {
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          return {
            type: 'assistant_text',
            text: truncateSnippet(block.text),
            timestamp: Date.now()
          };
        }
      }
      return null;
    }

    if (eventType === 'tool_call' && event.subtype === 'started') {
      const toolCall = event.tool_call || {};

      // Determine tool name and detail from the tool_call structure
      let toolName = 'unknown';
      let detail = '';

      if (toolCall.shellToolCall) {
        toolName = 'shell';
        const cmd = toolCall.shellToolCall.args?.command;
        if (cmd) detail = cmd;
      } else if (toolCall.readToolCall) {
        toolName = 'read';
        const filePath = toolCall.readToolCall.args?.path;
        if (filePath) detail = cwd ? stripPathPrefix(filePath, cwd) : filePath;
      } else if (toolCall.editToolCall) {
        toolName = 'edit';
        const filePath = toolCall.editToolCall.args?.path;
        if (filePath) detail = cwd ? stripPathPrefix(filePath, cwd) : filePath;
      } else {
        // Try to identify from keys
        const toolKeys = Object.keys(toolCall);
        if (toolKeys.length > 0) {
          toolName = toolKeys[0].replace('ToolCall', '');
        }
      }

      const text = detail ? `${toolName}: ${detail}` : toolName;
      return {
        type: 'tool_use',
        text: truncateSnippet(text),
        timestamp: Date.now()
      };
    }

    // system, user, tool_call completed, result — never emit
    return null;
  } catch {
    // Best-effort side channel — silently ignore non-JSON or malformed lines.
    return null;
  }
}

/**
 * Parse a single Pi JSONL line into a normalized event.
 * Returns null if the line should not be emitted.
 *
 * Pi JSONL event types:
 * - message_update (assistantMessageEvent.type === 'text_delta') → assistant_text
 * - message_end (role: 'assistant', content blocks with text) → assistant_text
 * - tool_execution_start (toolName, args) → tool_use
 * - session, turn_start, turn_end, message_start, tool_execution_update,
 *   tool_execution_end, agent_start, agent_end → filtered out
 *
 * @param {string} line - A single JSONL line from Pi stdout
 * @param {Object} [options] - Parse options
 * @param {string} [options.cwd] - Working directory to strip from file paths
 * @returns {{ type: string, text: string, timestamp: number } | null}
 */
function parsePiLine(line, options = {}) {
  if (!line || !line.trim()) return null;

  const { cwd } = options;

  try {
    const event = JSON.parse(line);
    const eventType = event.type;

    // Streaming text deltas from message_update events
    if (eventType === 'message_update') {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent?.type === 'text_delta' && assistantEvent?.delta?.trim()) {
        return {
          type: 'assistant_text',
          text: truncateSnippet(assistantEvent.delta),
          timestamp: Date.now()
        };
      }
      return null;
    }

    // Complete assistant message from message_end
    if (eventType === 'message_end' && event.message?.role === 'assistant') {
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            return {
              type: 'assistant_text',
              text: truncateSnippet(block.text),
              timestamp: Date.now()
            };
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        return {
          type: 'assistant_text',
          text: truncateSnippet(content),
          timestamp: Date.now()
        };
      }
      return null;
    }

    // Tool execution start events
    if (eventType === 'tool_execution_start') {
      const toolName = event.toolName || 'unknown';
      const detail = extractToolDetail(event.args, cwd);
      const text = detail ? `${toolName}: ${detail}` : toolName;
      return {
        type: 'tool_use',
        text: truncateSnippet(text),
        timestamp: Date.now()
      };
    }

    // Tool execution end — emit for task tools to show completion status
    if (eventType === 'tool_execution_end') {
      const toolName = event.toolName || '';
      if (toolName === 'task') {
        const isError = event.isError || false;
        const result = event.result || '';
        // Extract a short summary from the result
        let summary = '';
        if (typeof result === 'string') {
          // First non-empty line as preview
          const firstLine = result.split('\n').find(l => l.trim());
          if (firstLine) summary = firstLine.trim();
        }
        const status = isError ? '✗' : '✓';
        const text = summary
          ? `task ${status}: ${summary}`
          : `task ${status}`;
        return {
          type: 'tool_use',
          text: truncateSnippet(text),
          timestamp: Date.now()
        };
      }
    }

    // session, turn_start, turn_end, message_start, tool_execution_update,
    // tool_execution_end (non-task), agent_start, agent_end — never emit
    return null;
  } catch {
    // Best-effort side channel — silently ignore non-JSON or malformed lines.
    return null;
  }
}

/**
 * Create a stateful Pi line parser that accumulates text_delta fragments
 * before emitting. This prevents flooding the UI with tiny text updates.
 *
 * Accumulates text_delta content and only emits an assistant_text event
 * when enough text has been collected (>= 80 chars). When a non-text-delta
 * event arrives (tool_execution_start, message_end, etc.), accumulated text
 * is discarded in favor of the more informative event.
 *
 * The returned function has the same signature as parsePiLine and can be
 * used as a drop-in replacement with StreamParser.
 *
 * @returns {Function} Stateful line parser with same signature as parsePiLine
 */
function createPiLineParser() {
  let accumulatedDelta = '';

  return function parsePiLineBuffered(line, options = {}) {
    if (!line || !line.trim()) return null;

    try {
      const event = JSON.parse(line);
      const eventType = event.type;

      // Accumulate text_delta fragments instead of emitting each one
      if (eventType === 'message_update') {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === 'text_delta' && assistantEvent?.delta) {
          accumulatedDelta += assistantEvent.delta;
          // Only emit when we have accumulated a meaningful chunk
          if (accumulatedDelta.length >= 80) {
            const text = accumulatedDelta;
            accumulatedDelta = '';
            return {
              type: 'assistant_text',
              text: truncateSnippet(text),
              timestamp: Date.now()
            };
          }
          // Not enough accumulated yet — suppress this event
          return null;
        }
        return null;
      }

      // Non-text-delta event: discard accumulated text (the real event is
      // more informative) and reset the buffer. The accumulated deltas are
      // only preview snippets; authoritative text extraction happens in
      // parsePiResponse.
      accumulatedDelta = '';

      // Fall through to stateless parsing for non-text-delta events
      return parsePiLine(line, options);
    } catch {
      return null;
    }
  };
}

module.exports = {
  StreamParser,
  truncateSnippet,
  stripPathPrefix,
  extractToolDetail,
  parseClaudeLine,
  parseCodexLine,
  parseGeminiLine,
  parseOpenCodeLine,
  parseCursorAgentLine,
  parsePiLine,
  createPiLineParser
};
