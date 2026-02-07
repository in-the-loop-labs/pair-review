// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to suppress output during tests
vi.mock('../../src/utils/logger', () => {
  return {
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      debug: vi.fn(),
      log: vi.fn()
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    log: vi.fn()
  };
});

const { StreamParser, truncateSnippet, stripPathPrefix, extractToolDetail, parseClaudeLine, parseCodexLine, parseGeminiLine, parseOpenCodeLine, parseCursorAgentLine, parsePiLine, createPiLineParser } = require('../../src/ai/stream-parser');

// ---------------------------------------------------------------------------
// truncateSnippet
// ---------------------------------------------------------------------------
describe('truncateSnippet', () => {
  it('returns empty string for null input', () => {
    expect(truncateSnippet(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(truncateSnippet(undefined)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(truncateSnippet('')).toBe('');
  });

  it('returns text as-is when under maxLen', () => {
    expect(truncateSnippet('hello world')).toBe('hello world');
  });

  it('collapses multiple whitespace chars to single spaces', () => {
    expect(truncateSnippet('hello   world')).toBe('hello world');
    expect(truncateSnippet('hello\n\nworld')).toBe('hello world');
    expect(truncateSnippet('hello\t\tworld')).toBe('hello world');
    expect(truncateSnippet('a  b\n\nc\td')).toBe('a b c d');
  });

  it('truncates with \u2026 when over maxLen', () => {
    const longText = 'a'.repeat(250);
    const result = truncateSnippet(longText);
    expect(result.length).toBe(201); // 200 chars + '\u2026'
    expect(result.endsWith('\u2026')).toBe(true);
    expect(result).toBe('a'.repeat(200) + '\u2026');
  });

  it('respects custom maxLen parameter', () => {
    const text = 'abcdefghij'; // 10 chars
    expect(truncateSnippet(text, 5)).toBe('abcde\u2026');
    expect(truncateSnippet(text, 10)).toBe('abcdefghij'); // exactly maxLen, no truncation
    expect(truncateSnippet(text, 3)).toBe('abc\u2026');
  });

  it('trims leading and trailing whitespace', () => {
    expect(truncateSnippet('  hello  ')).toBe('hello');
    expect(truncateSnippet('\n\thello\t\n')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// parseClaudeLine
// ---------------------------------------------------------------------------
describe('parseClaudeLine', () => {
  it('returns null for empty input', () => {
    expect(parseClaudeLine('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseClaudeLine(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseClaudeLine(undefined)).toBeNull();
  });

  it('parses stream_event with text_delta as assistant_text event', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        delta: {
          type: 'text_delta',
          text: 'Hello from Claude'
        }
      }
    });
    const result = parseClaudeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Hello from Claude');
    expect(typeof result.timestamp).toBe('number');
  });

  it('returns null for stream_event without text_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        delta: {
          type: 'content_block_start'
        }
      }
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('returns null for stream_event with text_delta but empty text', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        delta: {
          type: 'text_delta',
          text: ''
        }
      }
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('parses assistant message with tool_use block as tool_use event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: {}
          }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('Read');
    expect(typeof result.timestamp).toBe('number');
  });

  it('parses assistant message with tool_use that has command input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'npm test' }
          }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('Bash');
    expect(result.text).toContain('npm test');
  });

  it('parses assistant message with tool_use that has file_path input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/src/index.js' }
          }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('Read');
    expect(result.text).toContain('/src/index.js');
  });

  it('parses assistant message with tool_use that has path input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Glob',
            input: { path: '/src' }
          }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('Glob');
    expect(result.text).toContain('/src');
  });

  it('parses assistant message with text block as assistant_text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'I will analyze this code.'
          }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('I will analyze this code.');
  });

  it('returns null for user (tool_result) events', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'some result' }]
      }
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('returns null for result events', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'final output'
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('returns null for system events', () => {
    const line = JSON.stringify({
      type: 'system',
      message: 'system init'
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('returns null for malformed/non-JSON lines', () => {
    expect(parseClaudeLine('this is not json')).toBeNull();
    expect(parseClaudeLine('{invalid json}')).toBeNull();
    expect(parseClaudeLine('---')).toBeNull();
  });

  it('returns null for empty JSON object', () => {
    expect(parseClaudeLine('{}')).toBeNull();
  });

  it('truncates long text_delta content', () => {
    const longText = 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        delta: {
          type: 'text_delta',
          text: longText
        }
      }
    });
    const result = parseClaudeLine(line);
    expect(result.text.length).toBe(201); // 200 + \u2026
    expect(result.text.endsWith('\u2026')).toBe(true);
  });

  it('prefers text block over tool_use when both are present', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'Some text' }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Some text');
  });

  it('falls back to tool_use when no text block exists', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
        ]
      }
    });
    const result = parseClaudeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('Bash');
  });

  it('returns null for assistant message with empty content array', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [] }
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('returns null for assistant message with no message field', () => {
    const line = JSON.stringify({
      type: 'assistant'
    });
    expect(parseClaudeLine(line)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCodexLine
// ---------------------------------------------------------------------------
describe('parseCodexLine', () => {
  it('returns null for empty input', () => {
    expect(parseCodexLine('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseCodexLine(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseCodexLine(undefined)).toBeNull();
  });

  it('returns null for thread.started events', () => {
    const line = JSON.stringify({ type: 'thread.started' });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('returns null for turn.completed events', () => {
    const line = JSON.stringify({ type: 'turn.completed' });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('returns null for turn.started events', () => {
    const line = JSON.stringify({ type: 'turn.started' });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('parses item.completed with agent_message as assistant_text event', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'Analyzing the code now.'
      }
    });
    const result = parseCodexLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Analyzing the code now.');
    expect(typeof result.timestamp).toBe('number');
  });

  it('returns null for agent_message without text', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message'
      }
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('returns null for agent_message with empty text', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: ''
      }
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('parses item.completed with function_call as tool_use event', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'shell',
        arguments: '{"command":"npm test"}'
      }
    });
    const result = parseCodexLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('shell');
    expect(result.text).toContain('npm test');
  });

  it('parses item.completed with tool_call as tool_use event', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_call',
        name: 'read_file',
        arguments: '{"file_path":"/src/index.js"}'
      }
    });
    const result = parseCodexLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('read_file');
    expect(result.text).toContain('/src/index.js');
  });

  it('parses tool call with stringified JSON arguments containing command', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git status' })
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('bash');
    expect(result.text).toContain('git status');
  });

  it('parses tool call with object arguments containing file_path', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'read',
        input: { file_path: '/home/user/app.js' }
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('read');
    expect(result.text).toContain('/home/user/app.js');
  });

  it('parses tool call with object arguments containing path', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_call',
        name: 'glob',
        args: { path: '/src' }
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('glob');
    expect(result.text).toContain('/src');
  });

  it('uses tool field when name is not present', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_call',
        tool: 'my_tool'
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('my_tool');
  });

  it('falls back to unknown when neither name nor tool is present', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call'
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('unknown');
  });

  it('returns null for function_call_output (tool_result) events', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call_output',
        output: 'some output'
      }
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('returns null for tool_result items', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_result',
        content: 'result'
      }
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('returns null for reasoning items', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'reasoning',
        text: 'thinking...'
      }
    });
    expect(parseCodexLine(line)).toBeNull();
  });

  it('returns null for malformed/non-JSON lines', () => {
    expect(parseCodexLine('not json at all')).toBeNull();
    expect(parseCodexLine('{broken')).toBeNull();
    expect(parseCodexLine('12345')).toBeNull();
  });

  it('handles string arguments that are not valid JSON', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'shell',
        arguments: 'not-json-string'
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('shell');
    expect(result.text).toContain('not-json-string');
  });

  it('handles tool_use item type', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_use',
        name: 'editor',
        input: { command: 'open file.txt' }
      }
    });
    const result = parseCodexLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('editor');
    expect(result.text).toContain('open file.txt');
  });
});

// ---------------------------------------------------------------------------
// StreamParser
// ---------------------------------------------------------------------------
describe('StreamParser', () => {
  let onEvent;

  beforeEach(() => {
    onEvent = vi.fn();
  });

  it('feeds complete lines and calls onEvent for each parsed event', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const line1 = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'Hello' } }
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'World' }] }
    });

    parser.feed(line1 + '\n' + line2 + '\n');

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0].type).toBe('assistant_text');
    expect(onEvent.mock.calls[0][0].text).toBe('Hello');
    expect(onEvent.mock.calls[1][0].type).toBe('assistant_text');
    expect(onEvent.mock.calls[1][0].text).toBe('World');
  });

  it('buffers partial lines across multiple feed() calls', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const fullLine = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'buffered' } }
    });

    // Split the line roughly in half
    const mid = Math.floor(fullLine.length / 2);
    const part1 = fullLine.substring(0, mid);
    const part2 = fullLine.substring(mid);

    parser.feed(part1);
    expect(onEvent).not.toHaveBeenCalled();

    parser.feed(part2 + '\n');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].text).toBe('buffered');
  });

  it('flush() processes remaining buffer', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'flushed' } }
    });

    // Feed without trailing newline
    parser.feed(line);
    expect(onEvent).not.toHaveBeenCalled();

    parser.flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].text).toBe('flushed');
  });

  it('flush() clears buffer after processing', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'once' } }
    });

    parser.feed(line);
    parser.flush();
    expect(onEvent).toHaveBeenCalledTimes(1);

    // Second flush should not emit again
    parser.flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('handles empty chunks gracefully', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    parser.feed('');
    parser.feed('');
    parser.flush();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not call onEvent for lines that parseLine returns null for', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const userEvent = JSON.stringify({ type: 'user', message: {} });
    const systemEvent = JSON.stringify({ type: 'system', message: {} });
    const resultEvent = JSON.stringify({ type: 'result', result: {} });

    parser.feed(userEvent + '\n' + systemEvent + '\n' + resultEvent + '\n');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('handles multiple lines in a single chunk', () => {
    const parser = new StreamParser(parseCodexLine, onEvent);
    const line1 = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'first' }
    });
    const line2 = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'second' }
    });
    const line3 = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'third' }
    });

    parser.feed(line1 + '\n' + line2 + '\n' + line3 + '\n');

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls[0][0].text).toBe('first');
    expect(onEvent.mock.calls[1][0].text).toBe('second');
    expect(onEvent.mock.calls[2][0].text).toBe('third');
  });

  it('handles chunk ending with newline (no leftover buffer)', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'clean' } }
    });

    parser.feed(line + '\n');

    // Buffer should be empty — verify by flushing and getting no extra events
    expect(onEvent).toHaveBeenCalledTimes(1);
    parser.flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('handles Buffer input as well as string', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'from buffer' } }
    });

    parser.feed(Buffer.from(line + '\n'));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].text).toBe('from buffer');
  });

  it('skips blank lines between valid lines', () => {
    const parser = new StreamParser(parseClaudeLine, onEvent);
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'between blanks' } }
    });

    parser.feed('\n\n' + line + '\n\n');

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].text).toBe('between blanks');
  });

  it('works with a custom parseLine function', () => {
    const customParser = (line) => {
      if (line === 'EMIT') return { type: 'custom', text: 'emitted', timestamp: Date.now() };
      return null;
    };
    const parser = new StreamParser(customParser, onEvent);

    parser.feed('SKIP\nEMIT\nSKIP\n');

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].type).toBe('custom');
    expect(onEvent.mock.calls[0][0].text).toBe('emitted');
  });

  it('passes options through to parseLine', () => {
    const customParser = vi.fn((line, opts) => {
      if (line === 'test') return { type: 'custom', text: opts?.cwd || 'none', timestamp: Date.now() };
      return null;
    });
    const parser = new StreamParser(customParser, onEvent, { cwd: '/my/worktree' });

    parser.feed('test\n');

    expect(customParser).toHaveBeenCalledWith('test', { cwd: '/my/worktree' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].text).toBe('/my/worktree');
  });

  it('passes options through to parseLine on flush()', () => {
    const customParser = vi.fn((line, opts) => {
      return { type: 'custom', text: opts?.cwd || 'none', timestamp: Date.now() };
    });
    const parser = new StreamParser(customParser, onEvent, { cwd: '/flush/path' });

    parser.feed('leftover');
    parser.flush();

    expect(customParser).toHaveBeenCalledWith('leftover', { cwd: '/flush/path' });
  });

  it('continues processing after onEvent callback throws in feed()', () => {
    const errorEvent = vi.fn(() => {
      throw new Error('callback explosion');
    });

    const parser = new StreamParser(parseClaudeLine, errorEvent);
    const line1 = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'first' } }
    });
    const line2 = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'second' } }
    });

    // Should not throw, and should process both lines
    parser.feed(line1 + '\n' + line2 + '\n');

    // Both events were attempted despite the callback throwing
    expect(errorEvent).toHaveBeenCalledTimes(2);
  });

  it('continues processing after onEvent callback throws in flush()', () => {
    const errorEvent = vi.fn(() => {
      throw new Error('flush explosion');
    });

    const parser = new StreamParser(parseClaudeLine, errorEvent);
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'flushed' } }
    });

    parser.feed(line);
    // Should not throw
    parser.flush();

    expect(errorEvent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// stripPathPrefix
// ---------------------------------------------------------------------------
describe('stripPathPrefix', () => {
  it('strips prefix from path', () => {
    expect(stripPathPrefix('/tmp/worktree-abc/src/index.js', '/tmp/worktree-abc')).toBe('src/index.js');
  });

  it('strips prefix with trailing slash', () => {
    expect(stripPathPrefix('/tmp/worktree-abc/src/index.js', '/tmp/worktree-abc/')).toBe('src/index.js');
  });

  it('returns original path when prefix does not match', () => {
    expect(stripPathPrefix('/other/path/file.js', '/tmp/worktree-abc')).toBe('/other/path/file.js');
  });

  it('handles null filePath', () => {
    expect(stripPathPrefix(null, '/tmp')).toBe('');
  });

  it('handles undefined filePath', () => {
    expect(stripPathPrefix(undefined, '/tmp')).toBe('');
  });

  it('handles null cwdPrefix', () => {
    expect(stripPathPrefix('/some/file.js', null)).toBe('/some/file.js');
  });

  it('handles empty cwdPrefix', () => {
    expect(stripPathPrefix('/some/file.js', '')).toBe('/some/file.js');
  });

  it('handles path that equals prefix exactly', () => {
    expect(stripPathPrefix('/tmp/worktree', '/tmp/worktree')).toBe('');
  });

  it('does not match prefix that shares a common path segment prefix', () => {
    // /tmp/work should NOT match /tmp/worker/foo.js
    expect(stripPathPrefix('/tmp/worker/foo.js', '/tmp/work')).toBe('/tmp/worker/foo.js');
  });

  it('does not mangle paths with similar directory names', () => {
    expect(stripPathPrefix('/home/user-extra/file.js', '/home/user')).toBe('/home/user-extra/file.js');
  });
});

// ---------------------------------------------------------------------------
// extractToolDetail
// ---------------------------------------------------------------------------
describe('extractToolDetail', () => {
  it('returns empty string for null/undefined input', () => {
    expect(extractToolDetail(null)).toBe('');
    expect(extractToolDetail(undefined)).toBe('');
  });

  it('extracts command field', () => {
    expect(extractToolDetail({ command: 'git diff HEAD' })).toBe('git diff HEAD');
  });

  it('extracts description field', () => {
    expect(extractToolDetail({ description: 'Explore codebase structure' })).toBe('Explore codebase structure');
  });

  it('prefers command over description', () => {
    expect(extractToolDetail({ command: 'ls', description: 'list files' })).toBe('ls');
  });

  it('prefers description over file_path', () => {
    expect(extractToolDetail({ description: 'Read config', file_path: '/src/config.js' })).toBe('Read config');
  });

  it('extracts file_path field', () => {
    expect(extractToolDetail({ file_path: '/src/app.js' })).toBe('/src/app.js');
  });

  it('extracts filePath (camelCase) field', () => {
    expect(extractToolDetail({ filePath: '/src/app.js' })).toBe('/src/app.js');
  });

  it('prefers file_path over filePath', () => {
    expect(extractToolDetail({ file_path: '/a.js', filePath: '/b.js' })).toBe('/a.js');
  });

  it('extracts path field', () => {
    expect(extractToolDetail({ path: '/src' })).toBe('/src');
  });

  it('strips cwd from file_path', () => {
    expect(extractToolDetail({ file_path: '/tmp/wt/src/app.js' }, '/tmp/wt')).toBe('src/app.js');
  });

  it('strips cwd from filePath', () => {
    expect(extractToolDetail({ filePath: '/tmp/wt/src/app.js' }, '/tmp/wt')).toBe('src/app.js');
  });

  it('strips cwd from path', () => {
    expect(extractToolDetail({ path: '/tmp/wt/src' }, '/tmp/wt')).toBe('src');
  });

  it('returns empty string for object with no recognized fields', () => {
    expect(extractToolDetail({ foo: 'bar' })).toBe('');
  });

  it('parses JSON string input', () => {
    expect(extractToolDetail(JSON.stringify({ command: 'git log' }))).toBe('git log');
  });

  it('parses JSON string with filePath', () => {
    expect(extractToolDetail(JSON.stringify({ filePath: '/src/index.js' }))).toBe('/src/index.js');
  });

  it('returns plain string input when not valid JSON', () => {
    expect(extractToolDetail('not-json')).toBe('not-json');
  });

  it('returns empty string for non-string non-object', () => {
    expect(extractToolDetail(42)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseClaudeLine with cwd option
// ---------------------------------------------------------------------------
describe('parseClaudeLine with cwd option', () => {
  it('strips cwd prefix from file_path in tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Read',
          input: { file_path: '/tmp/worktree-abc/src/index.js' }
        }]
      }
    });
    const result = parseClaudeLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/index.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd prefix from path in tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Glob',
          input: { path: '/tmp/worktree-abc/src' }
        }]
      }
    });
    const result = parseClaudeLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('does not strip when cwd not provided', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Read',
          input: { file_path: '/tmp/worktree-abc/src/index.js' }
        }]
      }
    });
    const result = parseClaudeLine(line);
    expect(result.text).toContain('/tmp/worktree-abc/src/index.js');
  });

  it('does not affect assistant_text events', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'Hello' } }
    });
    const result = parseClaudeLine(line, { cwd: '/tmp' });
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Hello');
  });

  it('extracts description from Task tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Task',
          input: { description: 'Explore codebase structure' }
        }]
      }
    });
    const result = parseClaudeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('Task: Explore codebase structure');
  });

  it('extracts filePath (camelCase) from tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Read',
          input: { filePath: '/tmp/wt/src/app.js' }
        }]
      }
    });
    const result = parseClaudeLine(line, { cwd: '/tmp/wt' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/app.js');
    expect(result.text).not.toContain('/tmp/wt');
  });
});

// ---------------------------------------------------------------------------
// parseCodexLine with cwd option
// ---------------------------------------------------------------------------
describe('parseCodexLine with cwd option', () => {
  it('strips cwd prefix from file_path in tool call arguments', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'read',
        input: { file_path: '/tmp/worktree-abc/src/app.js' }
      }
    });
    const result = parseCodexLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/app.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd prefix from path in tool call args', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'tool_call',
        name: 'glob',
        args: { path: '/tmp/worktree-abc/src' }
      }
    });
    const result = parseCodexLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('does not strip when cwd not provided', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'function_call',
        name: 'read',
        input: { file_path: '/tmp/worktree-abc/src/app.js' }
      }
    });
    const result = parseCodexLine(line);
    expect(result.text).toContain('/tmp/worktree-abc/src/app.js');
  });
});

// ---------------------------------------------------------------------------
// parseGeminiLine
// ---------------------------------------------------------------------------
describe('parseGeminiLine', () => {
  it('returns null for empty/null/undefined input', () => {
    expect(parseGeminiLine(null)).toBeNull();
    expect(parseGeminiLine(undefined)).toBeNull();
    expect(parseGeminiLine('')).toBeNull();
    expect(parseGeminiLine('   ')).toBeNull();
  });

  it('returns null for non-JSON lines', () => {
    expect(parseGeminiLine('not json at all')).toBeNull();
  });

  it('parses assistant message as assistant_text', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: 'Analyzing the diff now...'
    });
    const result = parseGeminiLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Analyzing the diff now...');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('returns null for user messages', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'user',
      content: 'Review this code'
    });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('returns null for assistant message with empty content', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: ''
    });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('returns null for assistant message with whitespace-only content', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: '   '
    });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('returns null for assistant message with no content field', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant'
    });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('parses tool_use with tool_name and command parameter', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'run_shell_command',
      parameters: { command: 'git diff HEAD~1' }
    });
    const result = parseGeminiLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('run_shell_command: git diff HEAD~1');
  });

  it('parses tool_use with file_path parameter', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: { file_path: '/src/app.js' }
    });
    const result = parseGeminiLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('read_file: /src/app.js');
  });

  it('parses tool_use with path parameter', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'glob',
      parameters: { path: '/src' }
    });
    const result = parseGeminiLine(line);
    expect(result.text).toBe('glob: /src');
  });

  it('parses tool_use with no parameters', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'list_directory'
    });
    const result = parseGeminiLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('list_directory');
  });

  it('defaults tool_name to unknown', () => {
    const line = JSON.stringify({ type: 'tool_use' });
    const result = parseGeminiLine(line);
    expect(result.text).toBe('unknown');
  });

  it('returns null for init events', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'abc', model: 'gemini-2.5-pro' });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('returns null for tool_result events', () => {
    const line = JSON.stringify({ type: 'tool_result', tool_id: 'abc', status: 'ok', output: 'data' });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('returns null for result events', () => {
    const line = JSON.stringify({ type: 'result', stats: { total_tokens: 5000 } });
    expect(parseGeminiLine(line)).toBeNull();
  });

  it('truncates long assistant text', () => {
    const longText = 'x'.repeat(300);
    const line = JSON.stringify({ type: 'message', role: 'assistant', content: longText });
    const result = parseGeminiLine(line);
    expect(result.text.length).toBe(201); // 200 + ellipsis
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('truncates long tool_use text', () => {
    const longCmd = 'git diff ' + 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'run_shell_command',
      parameters: { command: longCmd }
    });
    const result = parseGeminiLine(line);
    expect(result.text.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// parseGeminiLine with cwd option
// ---------------------------------------------------------------------------
describe('parseGeminiLine with cwd option', () => {
  it('strips cwd prefix from file_path in tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: { file_path: '/tmp/worktree-abc/src/index.js' }
    });
    const result = parseGeminiLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/index.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd prefix from path in tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'glob',
      parameters: { path: '/tmp/worktree-abc/src' }
    });
    const result = parseGeminiLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('does not strip when cwd not provided', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: { file_path: '/tmp/worktree-abc/src/index.js' }
    });
    const result = parseGeminiLine(line);
    expect(result.text).toContain('/tmp/worktree-abc/src/index.js');
  });

  it('does not affect assistant_text events', () => {
    const line = JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello' });
    const result = parseGeminiLine(line, { cwd: '/tmp' });
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// parseOpenCodeLine
// ---------------------------------------------------------------------------
describe('parseOpenCodeLine', () => {
  it('returns null for empty/null/undefined input', () => {
    expect(parseOpenCodeLine(null)).toBeNull();
    expect(parseOpenCodeLine(undefined)).toBeNull();
    expect(parseOpenCodeLine('')).toBeNull();
    expect(parseOpenCodeLine('   ')).toBeNull();
  });

  it('returns null for non-JSON lines', () => {
    expect(parseOpenCodeLine('not json')).toBeNull();
  });

  it('parses text event with part.text as assistant_text', () => {
    const line = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: 'Looking at the changes...' }
    });
    const result = parseOpenCodeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Looking at the changes...');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('parses text event with direct event.text', () => {
    const line = JSON.stringify({
      type: 'text',
      text: 'Direct text content'
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Direct text content');
  });

  it('returns null for text event with empty text', () => {
    const line = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: '' }
    });
    expect(parseOpenCodeLine(line)).toBeNull();
  });

  it('returns null for text event with whitespace-only text', () => {
    const line = JSON.stringify({
      type: 'text',
      part: { type: 'text', text: '   ' }
    });
    expect(parseOpenCodeLine(line)).toBeNull();
  });

  it('parses tool_use event with part.tool and state.input command', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'abc123',
        state: { input: { command: 'git diff HEAD~1' } }
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('bash: git diff HEAD~1');
  });

  it('parses tool_call event with part.tool and file_path', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      part: {
        tool: 'read',
        state: { input: { file_path: '/src/app.js' } }
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('read: /src/app.js');
  });

  it('parses tool_use with path parameter', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'glob',
        state: { input: { path: '/src' } }
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.text).toBe('glob: /src');
  });

  it('parses tool_use with filePath (camelCase) in state.input', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'read',
        state: { input: { filePath: '/src/app.js' } }
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('read: /src/app.js');
  });

  it('parses tool_use with description field (Task tool)', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'Task',
        state: { input: { description: 'Explore codebase structure' } }
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('Task: Explore codebase structure');
  });

  it('parses tool_use with filePath in JSON-encoded string args', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'read',
        input: JSON.stringify({ filePath: '/src/index.js', offset: 10, limit: 50 })
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('read: /src/index.js');
  });

  it('parses tool_use with no input', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: { tool: 'list_files' }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('list_files');
  });

  it('parses tool_use with string arguments (JSON-encoded)', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'bash',
        input: JSON.stringify({ command: 'ls -la' })
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('bash: ls -la');
  });

  it('parses tool_use with string arguments (plain string)', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'bash',
        input: 'not-json-string'
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('bash: not-json-string');
  });

  it('defaults tool name to unknown', () => {
    const line = JSON.stringify({ type: 'tool_use', part: {} });
    const result = parseOpenCodeLine(line);
    expect(result.text).toBe('unknown');
  });

  it('returns null for step_start events', () => {
    const line = JSON.stringify({ type: 'step_start' });
    expect(parseOpenCodeLine(line)).toBeNull();
  });

  it('returns null for step_finish events', () => {
    const line = JSON.stringify({ type: 'step_finish', part: { reason: 'end_turn' } });
    expect(parseOpenCodeLine(line)).toBeNull();
  });

  it('returns null for tool_result events', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      part: { tool_use_id: 'abc', output: 'file contents here' }
    });
    expect(parseOpenCodeLine(line)).toBeNull();
  });

  it('truncates long assistant text', () => {
    const longText = 'y'.repeat(300);
    const line = JSON.stringify({ type: 'text', part: { text: longText } });
    const result = parseOpenCodeLine(line);
    expect(result.text.length).toBe(201);
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('truncates long tool_use text', () => {
    const longCmd = 'git diff ' + 'z'.repeat(300);
    const line = JSON.stringify({
      type: 'tool_use',
      part: { tool: 'bash', state: { input: { command: longCmd } } }
    });
    const result = parseOpenCodeLine(line);
    expect(result.text.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// parseOpenCodeLine with cwd option
// ---------------------------------------------------------------------------
describe('parseOpenCodeLine with cwd option', () => {
  it('strips cwd prefix from file_path in tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'read',
        state: { input: { file_path: '/tmp/worktree-abc/src/index.js' } }
      }
    });
    const result = parseOpenCodeLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/index.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd prefix from path in tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'glob',
        state: { input: { path: '/tmp/worktree-abc/src' } }
      }
    });
    const result = parseOpenCodeLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd from JSON-encoded string arguments', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'read',
        input: JSON.stringify({ file_path: '/tmp/worktree-abc/src/app.js' })
      }
    });
    const result = parseOpenCodeLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src/app.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('does not strip when cwd not provided', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'read',
        state: { input: { file_path: '/tmp/worktree-abc/src/index.js' } }
      }
    });
    const result = parseOpenCodeLine(line);
    expect(result.text).toContain('/tmp/worktree-abc/src/index.js');
  });

  it('does not affect assistant_text events', () => {
    const line = JSON.stringify({ type: 'text', part: { text: 'Hello' } });
    const result = parseOpenCodeLine(line, { cwd: '/tmp' });
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// parseCursorAgentLine
// ---------------------------------------------------------------------------
describe('parseCursorAgentLine', () => {
  it('returns null for empty/null/undefined input', () => {
    expect(parseCursorAgentLine(null)).toBeNull();
    expect(parseCursorAgentLine(undefined)).toBeNull();
    expect(parseCursorAgentLine('')).toBeNull();
    expect(parseCursorAgentLine('   ')).toBeNull();
  });

  it('returns null for non-JSON lines', () => {
    expect(parseCursorAgentLine('not json at all')).toBeNull();
  });

  it('parses assistant message with text content as assistant_text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Analyzing the code now.' }]
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Analyzing the code now.');
    expect(typeof result.timestamp).toBe('number');
  });

  it('parses assistant streaming delta events as assistant_text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial response' }]
      },
      timestamp_ms: 1234567890
    });
    const result = parseCursorAgentLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('partial response');
  });

  it('returns null for assistant message with empty text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }]
      }
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('returns null for assistant message with whitespace-only text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '   ' }]
      }
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('returns null for assistant message with no content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant' }
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('returns null for assistant message with empty content array', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [] }
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('parses tool_call started with shellToolCall as tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_abc123',
      tool_call: {
        shellToolCall: {
          args: { command: 'git diff HEAD~1' }
        }
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('shell');
    expect(result.text).toContain('git diff HEAD~1');
  });

  it('parses tool_call started with readToolCall as tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_read123',
      tool_call: {
        readToolCall: {
          args: { path: '/src/app.js' }
        }
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('read');
    expect(result.text).toContain('/src/app.js');
  });

  it('parses tool_call started with editToolCall as tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_edit123',
      tool_call: {
        editToolCall: {
          args: { path: '/src/config.js' }
        }
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('edit');
    expect(result.text).toContain('/src/config.js');
  });

  it('handles unknown tool call types', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_custom',
      tool_call: {
        customToolCall: { args: {} }
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('custom');
  });

  it('handles empty tool_call object', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'tool_empty',
      tool_call: {}
    });
    const result = parseCursorAgentLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('unknown');
  });

  it('returns null for tool_call completed events', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'tool_abc123',
      tool_call: {
        shellToolCall: {
          result: { rejected: { command: 'echo hello' } }
        }
      }
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('returns null for system events', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc123',
      model: 'Claude 4.5 Sonnet'
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('returns null for user events', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'test prompt' }]
      }
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('returns null for result events', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 5000,
      result: 'some result'
    });
    expect(parseCursorAgentLine(line)).toBeNull();
  });

  it('truncates long assistant text', () => {
    const longText = 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: longText }]
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result.text.length).toBe(201); // 200 + ellipsis
    expect(result.text.endsWith('\u2026')).toBe(true);
  });

  it('truncates long tool_use text', () => {
    const longCmd = 'git diff ' + 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        shellToolCall: { args: { command: longCmd } }
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result.text.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// parseCursorAgentLine with cwd option
// ---------------------------------------------------------------------------
describe('parseCursorAgentLine with cwd option', () => {
  it('strips cwd prefix from readToolCall path', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        readToolCall: {
          args: { path: '/tmp/worktree-abc/src/index.js' }
        }
      }
    });
    const result = parseCursorAgentLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/index.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd prefix from editToolCall path', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        editToolCall: {
          args: { path: '/tmp/worktree-abc/src/app.js' }
        }
      }
    });
    const result = parseCursorAgentLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src/app.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('does not strip cwd from shell commands', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        shellToolCall: {
          args: { command: 'git diff HEAD~1' }
        }
      }
    });
    const result = parseCursorAgentLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('git diff HEAD~1');
  });

  it('does not strip when cwd not provided', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        readToolCall: {
          args: { path: '/tmp/worktree-abc/src/index.js' }
        }
      }
    });
    const result = parseCursorAgentLine(line);
    expect(result.text).toContain('/tmp/worktree-abc/src/index.js');
  });

  it('does not affect assistant_text events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }]
      }
    });
    const result = parseCursorAgentLine(line, { cwd: '/tmp' });
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// parsePiLine
// ---------------------------------------------------------------------------
describe('parsePiLine', () => {
  it('returns null for empty/null/undefined input', () => {
    expect(parsePiLine(null)).toBeNull();
    expect(parsePiLine(undefined)).toBeNull();
    expect(parsePiLine('')).toBeNull();
    expect(parsePiLine('   ')).toBeNull();
  });

  it('returns null for non-JSON lines', () => {
    expect(parsePiLine('not json at all')).toBeNull();
  });

  it('parses message_update with text_delta as assistant_text', () => {
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Analyzing the changes...'
      }
    });
    const result = parsePiLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Analyzing the changes...');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('returns null for message_update with empty text_delta', () => {
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: ''
      }
    });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for message_update with whitespace-only text_delta', () => {
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: '   '
      }
    });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for message_update without assistantMessageEvent', () => {
    const line = JSON.stringify({ type: 'message_update' });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for message_update with non-text_delta type', () => {
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'tool_use_start',
        toolCallId: 'abc'
      }
    });
    expect(parsePiLine(line)).toBeNull();
  });

  it('parses message_end with assistant content blocks as assistant_text', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final analysis complete.' }]
      }
    });
    const result = parsePiLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Final analysis complete.');
  });

  it('parses message_end with string content', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: 'Simple string content'
      }
    });
    const result = parsePiLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Simple string content');
  });

  it('returns null for message_end from non-assistant role', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'user message' }]
      }
    });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for message_end with empty content array', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [] }
    });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for message_end with whitespace-only string content', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: '   ' }
    });
    expect(parsePiLine(line)).toBeNull();
  });

  it('parses tool_execution_start with command as tool_use', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call_abc123',
      args: { command: 'git diff HEAD~1' }
    });
    const result = parsePiLine(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('bash: git diff HEAD~1');
  });

  it('parses tool_execution_start with file_path', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { file_path: '/src/app.js' }
    });
    const result = parsePiLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('read: /src/app.js');
  });

  it('parses tool_execution_start with path', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'glob',
      args: { path: '/src' }
    });
    const result = parsePiLine(line);
    expect(result.text).toBe('glob: /src');
  });

  it('parses tool_execution_start with no args', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'list_files'
    });
    const result = parsePiLine(line);
    expect(result.type).toBe('tool_use');
    expect(result.text).toBe('list_files');
  });

  it('defaults toolName to unknown', () => {
    const line = JSON.stringify({ type: 'tool_execution_start' });
    const result = parsePiLine(line);
    expect(result.text).toBe('unknown');
  });

  it('returns null for session events', () => {
    const line = JSON.stringify({ type: 'session', version: 3, id: 'test-session' });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for turn_start events', () => {
    const line = JSON.stringify({ type: 'turn_start' });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for turn_end events', () => {
    const line = JSON.stringify({ type: 'turn_end', message: { role: 'assistant' } });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for message_start events', () => {
    const line = JSON.stringify({ type: 'message_start', message: { role: 'assistant' } });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for tool_execution_update events', () => {
    const line = JSON.stringify({ type: 'tool_execution_update', partialResult: 'data' });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for tool_execution_end events', () => {
    const line = JSON.stringify({ type: 'tool_execution_end', result: 'ok', isError: false });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for agent_start events', () => {
    const line = JSON.stringify({ type: 'agent_start' });
    expect(parsePiLine(line)).toBeNull();
  });

  it('returns null for agent_end events', () => {
    const line = JSON.stringify({ type: 'agent_end' });
    expect(parsePiLine(line)).toBeNull();
  });

  it('truncates long assistant text', () => {
    const longText = 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: longText }
    });
    const result = parsePiLine(line);
    expect(result.text.length).toBe(201); // 200 + ellipsis
    expect(result.text.endsWith('\u2026')).toBe(true);
  });

  it('truncates long tool_use text', () => {
    const longCmd = 'git diff ' + 'x'.repeat(300);
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: longCmd }
    });
    const result = parsePiLine(line);
    expect(result.text.length).toBeLessThanOrEqual(201);
  });
});

// ---------------------------------------------------------------------------
// parsePiLine with cwd option
// ---------------------------------------------------------------------------
describe('parsePiLine with cwd option', () => {
  it('strips cwd prefix from file_path in tool_execution_start', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { file_path: '/tmp/worktree-abc/src/index.js' }
    });
    const result = parsePiLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('src/index.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('strips cwd prefix from path in tool_execution_start', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'glob',
      args: { path: '/tmp/worktree-abc/src' }
    });
    const result = parsePiLine(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });

  it('does not strip when cwd not provided', () => {
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { file_path: '/tmp/worktree-abc/src/index.js' }
    });
    const result = parsePiLine(line);
    expect(result.text).toContain('/tmp/worktree-abc/src/index.js');
  });

  it('does not affect assistant_text events', () => {
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
    });
    const result = parsePiLine(line, { cwd: '/tmp' });
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// createPiLineParser (buffered/stateful Pi line parser)
// ---------------------------------------------------------------------------
describe('createPiLineParser', () => {
  it('returns a function', () => {
    const parser = createPiLineParser();
    expect(typeof parser).toBe('function');
  });

  it('suppresses short text_delta fragments', () => {
    const parser = createPiLineParser();
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'tiny' }
    });
    // Short fragment should be buffered, not emitted
    const result = parser(line);
    expect(result).toBeNull();
  });

  it('emits accumulated text_delta when buffer reaches threshold', () => {
    const parser = createPiLineParser();
    // Feed multiple small deltas that together exceed the 80-char threshold
    const shortDelta = 'x'.repeat(30);
    const makeLine = (delta) => JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta }
    });

    // First call: 30 chars accumulated, under threshold
    expect(parser(makeLine(shortDelta))).toBeNull();
    // Second call: 60 chars accumulated, still under
    expect(parser(makeLine(shortDelta))).toBeNull();
    // Third call: 90 chars accumulated, over threshold — should emit
    const result = parser(makeLine(shortDelta));
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    // The emitted text is the accumulated content, truncated by truncateSnippet
    expect(result.text).toContain('x');
  });

  it('clears accumulated text when non-text event arrives', () => {
    const parser = createPiLineParser();
    // Accumulate some text
    parser(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'buffered text' }
    }));

    // Now a tool event arrives - accumulated text should be discarded
    const toolLine = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'git diff' }
    });
    const result = parser(toolLine);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('bash');
  });

  it('passes through non-text events unchanged', () => {
    const parser = createPiLineParser();
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { file_path: '/src/app.js' }
    });
    const result = parser(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('tool_use');
    expect(result.text).toContain('read');
    expect(result.text).toContain('/src/app.js');
  });

  it('passes through message_end events', () => {
    const parser = createPiLineParser();
    const line = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Final response text.' }]
      }
    });
    const result = parser(line);
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    expect(result.text).toBe('Final response text.');
  });

  it('returns null for empty/null input', () => {
    const parser = createPiLineParser();
    expect(parser('')).toBeNull();
    expect(parser(null)).toBeNull();
    expect(parser(undefined)).toBeNull();
  });

  it('returns null for non-JSON lines', () => {
    const parser = createPiLineParser();
    expect(parser('not json at all')).toBeNull();
  });

  it('accumulates whitespace-only text_delta fragments', () => {
    const parser = createPiLineParser();
    // Simulate: "Hello" + " " + "World" — the space must be preserved
    const makeLine = (delta) => JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta }
    });

    // Feed "Hello" (5 chars) — buffered
    expect(parser(makeLine('Hello'))).toBeNull();
    // Feed " " (whitespace-only, 1 char) — must be accumulated, not dropped
    expect(parser(makeLine(' '))).toBeNull();
    // Feed "World" (5 chars) — still buffered (total 11 chars, under 80 threshold)
    expect(parser(makeLine('World'))).toBeNull();

    // Now feed enough to cross the 80-char threshold
    // We have 11 chars so far, need 69 more to reach exactly 80 (which triggers >= 80)
    const result = parser(makeLine('x'.repeat(69)));
    // At 80 chars, the >= 80 check fires and emits
    expect(result).not.toBeNull();
    expect(result.type).toBe('assistant_text');
    // The accumulated text must contain the whitespace between Hello and World
    expect(result.text).toContain('Hello World');
  });

  it('does not drop single-space text_delta between words', () => {
    const parser = createPiLineParser();
    const makeLine = (delta) => JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta }
    });

    // Build up text with spaces: "a b c d e ..." pattern
    // Each pair is "X" + " " = 2 chars, need 40 pairs to hit 80 chars
    for (let i = 0; i < 39; i++) {
      parser(makeLine(String.fromCharCode(65 + (i % 26))));
      parser(makeLine(' '));
    }
    // 78 chars accumulated (39 letters + 39 spaces), feed 2 more to hit 80
    parser(makeLine('Z'));
    // 79 chars now; one more char will reach 80 and trigger emission
    const result = parser(makeLine('!'));
    // 80 chars accumulated, should emit
    expect(result).not.toBeNull();
    // The text should contain spaces (they weren't dropped)
    expect(result.text).toContain(' ');
  });

  it('works with StreamParser for end-to-end buffered streaming', () => {
    const onEvent = vi.fn();
    const parser = new StreamParser(createPiLineParser(), onEvent);

    // Feed many small text_delta events
    for (let i = 0; i < 5; i++) {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(10) }
      });
      parser.feed(line + '\n');
    }

    // With buffering, not every delta triggers an event
    // At 10 chars per delta, we need 8+ to reach 80 chars
    // After 5 deltas (50 chars), nothing should have emitted
    expect(onEvent).not.toHaveBeenCalled();

    // Feed more to cross the threshold
    for (let i = 0; i < 5; i++) {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(10) }
      });
      parser.feed(line + '\n');
    }

    // Now at 100 chars, should have emitted once (at the 80-char threshold)
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].type).toBe('assistant_text');
  });

  it('respects cwd option for tool events', () => {
    const parser = createPiLineParser();
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { file_path: '/tmp/worktree-abc/src/index.js' }
    });
    const result = parser(line, { cwd: '/tmp/worktree-abc' });
    expect(result.text).toContain('src/index.js');
    expect(result.text).not.toContain('/tmp/worktree-abc');
  });
});
