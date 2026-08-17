// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Pi JSONL Format Utilities
 *
 * Shared helpers for parsing the Pi coding agent's `--mode json` JSONL event
 * stream. The stream consists of event envelopes (session, agent_start,
 * turn_start, message_start/update/end, tool_execution_start/update/end,
 * turn_end, agent_end) with assistant text carried in message content blocks.
 *
 * Both the Pi provider (pi-provider.js) and the OMP provider (omp-provider.js)
 * consume this format — OMP (Oh My Pi) is a fork of Pi and emits an identical
 * event stream. Helpers that log accept an optional `cliName` so messages can
 * name the CLI that actually produced the output (defaults to 'Pi').
 */

const logger = require('../utils/logger');
const { extractJSON } = require('../utils/json-extractor');

// Keep raw stream capture bounded so large JSONL sessions cannot exhaust V8's
// maximum string size. Assistant text is still extracted incrementally from all
// complete JSONL lines and used as the primary parse/fallback input.
const MAX_PI_CAPTURED_STDOUT_CHARS = 5 * 1024 * 1024;
const MAX_PI_CAPTURED_STDERR_CHARS = 1 * 1024 * 1024;
const MAX_PI_LINE_CHARS = 2 * 1024 * 1024;
const PI_STDERR_HEAD_CHARS = 128 * 1024;
const PI_STDERR_TAIL_CHARS = MAX_PI_CAPTURED_STDERR_CHARS - PI_STDERR_HEAD_CHARS;
const PI_TRUNCATED_LINE_MARKER = '...[line truncated]...';

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

/**
 * Determine whether a parsed JSON object looks like a Pi JSONL event envelope
 * rather than a final review result payload.
 *
 * @param {Object} value - Parsed JSON object
 * @returns {boolean} True when the object appears to be a Pi event
 */
function isPiEventEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  if (typeof value.type !== 'string') {
    return false;
  }

  if (
    value.message ||
    Array.isArray(value.messages) ||
    value.assistantMessageEvent ||
    value.toolName ||
    value.toolCallId ||
    Object.hasOwn(value, 'partialResult') ||
    Object.hasOwn(value, 'result') ||
    Object.hasOwn(value, 'version')
  ) {
    return true;
  }

  return /_(start|update|end)$/.test(value.type) || value.type === 'session';
}

/**
 * Append a chunk to a captured stream buffer without exceeding the configured
 * maximum. Returns the updated buffer and whether truncation occurred.
 *
 * @param {string} existing - Existing captured output
 * @param {string} chunk - New output chunk
 * @param {number} maxChars - Maximum number of chars to retain
 * @returns {{value: string, truncated: boolean}}
 */
function appendWithLimit(existing, chunk, maxChars) {
  if (!chunk || maxChars <= 0) {
    return { value: existing, truncated: false };
  }

  const remaining = maxChars - existing.length;
  if (remaining <= 0) {
    return { value: existing, truncated: true };
  }

  if (chunk.length <= remaining) {
    return { value: existing + chunk, truncated: false };
  }

  return {
    value: existing + chunk.slice(0, remaining),
    truncated: true
  };
}

/**
 * Append a chunk to a bounded head+tail buffer so error logs preserve both the
 * start and end of noisy stderr output.
 *
 * @param {{head: string, tail: string, headFull: boolean, omittedChars: number}} buffer - Buffer state
 * @param {string} chunk - New stderr chunk
 * @param {number} maxHeadChars - Max chars to retain from the start
 * @param {number} maxTailChars - Max chars to retain from the end
 */
function appendHeadTailBuffer(buffer, chunk, maxHeadChars, maxTailChars) {
  if (!chunk) return;

  if (!buffer.headFull) {
    const remainingHead = maxHeadChars - buffer.head.length;
    if (chunk.length <= remainingHead) {
      buffer.head += chunk;
      if (buffer.head.length >= maxHeadChars) {
        buffer.headFull = true;
      }
      return;
    }

    const safeHead = Math.max(remainingHead, 0);
    buffer.head += chunk.slice(0, safeHead);
    buffer.headFull = true;

    const overflow = chunk.slice(safeHead);
    if (overflow.length > maxTailChars) {
      buffer.omittedChars += overflow.length - maxTailChars;
      buffer.tail = overflow.slice(-maxTailChars);
    } else {
      buffer.tail = overflow;
    }
    return;
  }

  const combinedTail = buffer.tail + chunk;
  if (combinedTail.length > maxTailChars) {
    buffer.omittedChars += combinedTail.length - maxTailChars;
    buffer.tail = combinedTail.slice(-maxTailChars);
  } else {
    buffer.tail = combinedTail;
  }
}

/**
 * Render a bounded head+tail buffer as a string for logs and error messages.
 *
 * @param {{head: string, tail: string, headFull: boolean, omittedChars: number}} buffer - Buffer state
 * @returns {string} Formatted stderr capture
 */
function formatHeadTailBuffer(buffer) {
  if (buffer.omittedChars === 0) {
    return `${buffer.head}${buffer.tail}`;
  }

  return `${buffer.head}\n...[${buffer.omittedChars} chars omitted]...\n${buffer.tail}`;
}

/**
 * Extract final assistant text from a Pi JSONL event.
 *
 * @param {Object} event - Parsed Pi event object
 * @param {Set<string>} seenTexts - Set tracking already-seen text blocks
 * @returns {string} Extracted text from the event
 */
function extractPiEventText(event, seenTexts) {
  let text = '';

  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    text += extractAssistantText(event.message.content, seenTexts);
  }

  if (event.type === 'turn_end' && event.message?.role === 'assistant') {
    text += extractAssistantText(event.message.content, seenTexts);
  }

  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    for (const msg of event.messages) {
      if (msg.role === 'assistant') {
        text += extractAssistantText(msg.content, seenTexts);
      }
    }
  }

  return text;
}

/**
 * Accumulate only raw lines that could plausibly help the direct JSON fallback.
 * Pi JSONL event envelopes are intentionally excluded because they are noisy
 * transport records, not the final review result.
 *
 * @param {string} line - One stdout line
 * @param {{rawOutput: string, rawOutputTruncated: boolean}} state - Parse state
 * @param {string} levelPrefix - Prefix used in logs
 * @param {{status: 'parsed', value: Object} | {status: 'failed'}} [parseResult] - Optional parse result reuse
 * @param {string} [cliName='Pi'] - CLI name used in log messages
 */
function accumulatePiRawFallbackLine(line, state, levelPrefix, parseResult, cliName = 'Pi') {
  if (!line?.trim()) return;

  let parsed;
  let parseFailed = false;

  if (parseResult?.status === 'parsed') {
    parsed = parseResult.value;
  } else if (parseResult?.status === 'failed') {
    parseFailed = true;
  } else {
    try {
      parsed = JSON.parse(line);
    } catch {
      parseFailed = true;
    }
  }

  if (!parseFailed && isPiEventEnvelope(parsed)) {
    return;
  }

  const capture = appendWithLimit(state.rawOutput, `${line}\n`, MAX_PI_CAPTURED_STDOUT_CHARS);
  state.rawOutput = capture.value;

  if (capture.truncated && !state.rawOutputTruncated) {
    state.rawOutputTruncated = true;
    logger.warn(
      `${levelPrefix} ${cliName} CLI raw-output fallback exceeded ${MAX_PI_CAPTURED_STDOUT_CHARS} chars; retaining only the first ${MAX_PI_CAPTURED_STDOUT_CHARS} chars`
    );
  }
}

/**
 * Parse a single Pi JSONL line into accumulated assistant text.
 *
 * @param {string} line - One JSONL line
 * @param {{textContent: string, seenTexts: Set<string>, rawOutput: string, rawOutputTruncated: boolean}} state - Parse state
 * @param {string} levelPrefix - Prefix used in logs
 * @param {string} [cliName='Pi'] - CLI name used in log messages
 */
function accumulatePiResponseLine(line, state, levelPrefix, cliName = 'Pi') {
  if (!line?.trim()) return;

  let parseResult;
  try {
    const event = JSON.parse(line);
    state.textContent += extractPiEventText(event, state.seenTexts);
    parseResult = { status: 'parsed', value: event };
  } catch {
    logger.debug(`${levelPrefix} Skipping malformed JSONL line: ${line.substring(0, 100)}`);
    parseResult = { status: 'failed' };
  }

  accumulatePiRawFallbackLine(line, state, levelPrefix, parseResult, cliName);
}

/**
 * Append stdout data to the pending JSONL line buffer while capping any single
 * unterminated line to avoid retaining multi-megabyte tool payloads in memory.
 *
 * @param {{buffer: string, lineTruncated: boolean, warningLogged: boolean}} state - Pending line state
 * @param {string} chunk - New stdout chunk
 * @param {string} levelPrefix - Prefix used in logs
 * @param {string} [cliName='Pi'] - CLI name used in log messages
 * @returns {string[]} Complete lines extracted from the chunk
 */
function appendPiChunkToLineBuffer(state, chunk, levelPrefix, cliName = 'Pi') {
  if (!chunk) return [];

  const lines = [];
  let cursor = 0;

  while (cursor < chunk.length) {
    if (state.lineTruncated) {
      const nextNewline = chunk.indexOf('\n', cursor);
      if (nextNewline === -1) {
        return lines;
      }

      lines.push(state.buffer);
      state.buffer = '';
      state.lineTruncated = false;
      cursor = nextNewline + 1;
      continue;
    }

    const nextNewline = chunk.indexOf('\n', cursor);
    const segmentEnd = nextNewline === -1 ? chunk.length : nextNewline;
    const segment = chunk.slice(cursor, segmentEnd);
    const remainingCapacity = MAX_PI_LINE_CHARS - state.buffer.length;

    if (segment.length <= remainingCapacity) {
      state.buffer += segment;
      if (nextNewline !== -1) {
        lines.push(state.buffer);
        state.buffer = '';
      }
      cursor = segmentEnd + (nextNewline === -1 ? 0 : 1);
      continue;
    }

    const safeCapacity = Math.max(remainingCapacity, 0);
    state.buffer += segment.slice(0, safeCapacity) + PI_TRUNCATED_LINE_MARKER;
    state.lineTruncated = true;

    if (!state.warningLogged) {
      state.warningLogged = true;
      logger.warn(
        `${levelPrefix} ${cliName} CLI emitted a JSONL event longer than ${MAX_PI_LINE_CHARS} chars; truncating the pending line buffer until the next newline`
      );
    }

    if (nextNewline !== -1) {
      lines.push(state.buffer);
      state.buffer = '';
      state.lineTruncated = false;
      cursor = nextNewline + 1;
      continue;
    }

    return lines;
  }

  return lines;
}

/**
 * Finalize Pi response parsing from incrementally extracted assistant text and
 * a bounded raw-output fallback buffer.
 *
 * @param {Object} input - Parse inputs
 * @param {string} input.textContent - Assistant text extracted from JSONL events
 * @param {string} input.rawOutput - Bounded raw stdout capture
 * @param {boolean} [input.rawOutputTruncated=false] - Whether raw stdout was truncated
 * @param {string|number} level - Analysis level for logging
 * @param {string} levelPrefix - Prefix used in logs
 * @param {string} [cliName='Pi'] - CLI name used in log and error messages
 * @returns {{success: boolean, data?: Object, error?: string, textContent?: string}}
 */
function finalizePiResponseParsing({ textContent, rawOutput, rawOutputTruncated = false }, level, levelPrefix, cliName = 'Pi') {
  if (textContent) {
    const extracted = extractJSON(textContent, level, levelPrefix);
    if (extracted.success) {
      return extracted;
    }

    logger.warn(`${levelPrefix} Text content is not JSON, treating as raw text`);
    return { success: false, error: 'Text content is not valid JSON', textContent };
  }

  if (rawOutputTruncated) {
    logger.warn(`${levelPrefix} ${cliName} CLI raw-output fallback was truncated before assistant text could be recovered`);
    return {
      success: false,
      error: `${cliName} CLI raw-output fallback was truncated before assistant text could be recovered`
    };
  }

  return extractJSON(rawOutput, level, levelPrefix);
}

/**
 * Log a streaming JSONL line for debugging visibility.
 * Extracts meaningful info from each event type without being too verbose.
 *
 * Uses logger.streamDebug() which only logs when --debug-stream flag is enabled.
 *
 * @param {string} line - A single JSONL line
 * @param {number} lineNum - Line number for reference
 * @param {string} levelPrefix - Level prefix for log messages
 */
function logPiStreamLine(line, lineNum, levelPrefix) {
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

module.exports = {
  MAX_PI_CAPTURED_STDOUT_CHARS,
  MAX_PI_CAPTURED_STDERR_CHARS,
  MAX_PI_LINE_CHARS,
  PI_STDERR_HEAD_CHARS,
  PI_STDERR_TAIL_CHARS,
  PI_TRUNCATED_LINE_MARKER,
  extractAssistantText,
  isPiEventEnvelope,
  appendWithLimit,
  appendHeadTailBuffer,
  formatHeadTailBuffer,
  extractPiEventText,
  accumulatePiRawFallbackLine,
  accumulatePiResponseLine,
  appendPiChunkToLineBuffer,
  finalizePiResponseParsing,
  logPiStreamLine
};
