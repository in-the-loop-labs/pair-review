// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Stream Parser - Side-channel parser for real-time AI streaming events
 *
 * Reads stdout data incrementally from provider processes and emits normalized
 * events for display in the ProgressModal. This is a read-only side channel;
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
          let detail = '';
          const input = block.input;
          if (input) {
            if (input.command) {
              detail = input.command;
            } else if (input.file_path || input.path) {
              const rawPath = input.file_path || input.path;
              detail = cwd ? stripPathPrefix(rawPath, cwd) : rawPath;
            }
          }
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
      let detail = '';
      const args = item.arguments || item.input || item.args || null;
      if (args) {
        let parsed = args;
        if (typeof args === 'string') {
          try { parsed = JSON.parse(args); } catch { parsed = args; }
        }
        if (typeof parsed === 'string') {
          detail = parsed;
        } else if (typeof parsed === 'object' && parsed !== null) {
          if (parsed.command) {
            detail = parsed.command;
          } else if (parsed.file_path || parsed.path) {
            const rawPath = parsed.file_path || parsed.path;
            detail = cwd ? stripPathPrefix(rawPath, cwd) : rawPath;
          }
        }
      }
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
 * Line-buffered stream parser that handles partial lines across chunks.
 * Feeds data incrementally and calls onEvent for each parsed event.
 */
class StreamParser {
  /**
   * @param {Function} parseLine - Provider-specific line parser (parseClaudeLine or parseCodexLine)
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

module.exports = {
  StreamParser,
  truncateSnippet,
  stripPathPrefix,
  parseClaudeLine,
  parseCodexLine
};
