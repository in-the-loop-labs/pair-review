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

const { StreamParser, truncateSnippet, stripPathPrefix, parseClaudeLine, parseCodexLine } = require('../../src/ai/stream-parser');

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
