// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock logger to suppress output during tests
vi.mock('../../../src/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  streamDebug: vi.fn(),
  section: vi.fn()
}));

// Patch child_process.spawn before PiBridge is loaded (it destructures spawn at import time)
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const mockSpawn = vi.fn();
childProcess.spawn = mockSpawn;

const PiBridge = require('../../../src/chat/pi-bridge');

/**
 * Helper to create a fake child process with real-enough streams for readline.
 */
function createFakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdin.writable = true;
  // Keep a spy on the original write so we can assert calls
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = vi.fn((...args) => origWrite(...args));
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe('PiBridge', () => {
  let fakeProc;

  afterAll(() => {
    childProcess.spawn = realSpawn;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);
  });

  describe('constructor', () => {
    it('should set default options', () => {
      const bridge = new PiBridge();
      expect(bridge.model).toBeNull();
      expect(bridge.provider).toBeNull();
      expect(bridge.cwd).toBe(process.cwd());
      expect(bridge.systemPrompt).toBeNull();
      expect(bridge.piCommand).toBe('pi');
    });

    it('should accept custom options', () => {
      const bridge = new PiBridge({
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        cwd: '/tmp/work',
        systemPrompt: 'Be helpful',
        piCommand: '/usr/local/bin/pi'
      });
      expect(bridge.model).toBe('claude-sonnet-4');
      expect(bridge.provider).toBe('anthropic');
      expect(bridge.cwd).toBe('/tmp/work');
      expect(bridge.systemPrompt).toBe('Be helpful');
      expect(bridge.piCommand).toBe('/usr/local/bin/pi');
    });

    it('should accept sessionPath option', () => {
      const bridge = new PiBridge({ sessionPath: '/tmp/session.json' });
      expect(bridge.sessionPath).toBe('/tmp/session.json');
    });

    it('should default sessionPath to null', () => {
      const bridge = new PiBridge();
      expect(bridge.sessionPath).toBeNull();
    });

    it('should use PAIR_REVIEW_PI_CMD env var when set', () => {
      const orig = process.env.PAIR_REVIEW_PI_CMD;
      process.env.PAIR_REVIEW_PI_CMD = '/custom/pi';
      try {
        const bridge = new PiBridge();
        expect(bridge.piCommand).toBe('/custom/pi');
      } finally {
        if (orig === undefined) {
          delete process.env.PAIR_REVIEW_PI_CMD;
        } else {
          process.env.PAIR_REVIEW_PI_CMD = orig;
        }
      }
    });
  });

  describe('_buildArgs', () => {
    it('should include --mode rpc and --tools with safe defaults', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).toContain('--mode');
      expect(args).toContain('rpc');
      expect(args).not.toContain('--no-session');
      expect(args).toContain('--tools');
      expect(args).toContain('read,grep,find,ls');
    });

    it('should use custom tools when specified', () => {
      const bridge = new PiBridge({ tools: 'read,bash,grep,find,ls' });
      const args = bridge._buildArgs();
      expect(args).toContain('read,bash,grep,find,ls');
      expect(args).not.toContain('read,grep,find,ls');
      expect(args.filter(a => a === '--tools').length).toBe(1);
    });

    it('should include provider when specified', () => {
      const bridge = new PiBridge({ provider: 'anthropic' });
      const args = bridge._buildArgs();
      expect(args).toContain('--provider');
      expect(args).toContain('anthropic');
    });

    it('should include model when specified', () => {
      const bridge = new PiBridge({ model: 'claude-sonnet-4' });
      const args = bridge._buildArgs();
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4');
    });

    it('should include --append-system-prompt when specified', () => {
      const bridge = new PiBridge({ systemPrompt: 'You are a reviewer' });
      const args = bridge._buildArgs();
      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('You are a reviewer');
    });

    it('should not include --provider when not specified', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--provider');
    });

    it('should not include --model when not specified', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--model');
    });

    it('should not include --append-system-prompt when not specified', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--append-system-prompt');
    });

    it('should include --session when sessionPath is set', () => {
      const bridge = new PiBridge({ sessionPath: '/tmp/session.json' });
      const args = bridge._buildArgs();
      expect(args).toContain('--session');
      expect(args).toContain('/tmp/session.json');
    });

    it('should not include --session when sessionPath is null', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--session');
    });
  });

  describe('_handleLine', () => {
    it('should ignore empty lines', () => {
      const bridge = new PiBridge();
      const deltaHandler = vi.fn();
      bridge.on('delta', deltaHandler);

      bridge._handleLine('');
      bridge._handleLine('   ');

      expect(deltaHandler).not.toHaveBeenCalled();
    });

    it('should ignore unparseable JSON', () => {
      const bridge = new PiBridge();
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      bridge._handleLine('not json at all');
      bridge._handleLine('{broken json');

      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should emit tool_use on tool_execution_start', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleLine(JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'call_123',
        toolName: 'read',
        args: { file_path: '/tmp/test.js' }
      }));

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'call_123',
        toolName: 'read',
        args: { file_path: '/tmp/test.js' },
        status: 'start'
      });
    });

    it('should emit tool_use on tool_execution_update', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleLine(JSON.stringify({
        type: 'tool_execution_update',
        toolCallId: 'call_123',
        toolName: 'read',
        partialResult: 'some output'
      }));

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'call_123',
        toolName: 'read',
        status: 'update',
        partialResult: 'some output'
      });
    });

    it('should emit tool_use on tool_execution_end', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleLine(JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'call_123',
        toolName: 'read',
        result: 'file contents',
        isError: false
      }));

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'call_123',
        toolName: 'read',
        status: 'end',
        result: 'file contents',
        isError: false
      });
    });

    it('should emit error on failed response events', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('error', handler);

      bridge._handleLine(JSON.stringify({
        type: 'response',
        success: false,
        error: 'Command failed'
      }));

      expect(handler).toHaveBeenCalledWith({
        error: expect.any(Error)
      });
      expect(handler.mock.calls[0][0].error.message).toBe('Command failed');
    });

    it('should store sessionFile from session event and emit session event', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('session', handler);

      bridge._handleLine(JSON.stringify({
        type: 'session',
        sessionFile: '/tmp/pi-session.json'
      }));

      expect(bridge.sessionPath).toBe('/tmp/pi-session.json');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionFile: '/tmp/pi-session.json' })
      );
    });

  });

  describe('_handleMessageUpdate', () => {
    it('should emit delta on text_delta events', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleMessageUpdate({
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'Hello '
        }
      });

      expect(handler).toHaveBeenCalledWith({ text: 'Hello ' });
    });

    it('should accumulate text across multiple deltas', () => {
      const bridge = new PiBridge();

      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' }
      });
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_delta', delta: 'world' }
      });

      expect(bridge._accumulatedText).toBe('Hello world');
    });

    it('should not emit delta when assistantMessageEvent is missing', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleMessageUpdate({});

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit delta for non text_delta event types', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_start' }
      });
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_end' }
      });
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit error on streaming error event', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('error', handler);

      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'error', error: 'Rate limit exceeded' }
      });

      expect(handler).toHaveBeenCalledWith({
        error: expect.any(Error)
      });
      expect(handler.mock.calls[0][0].error.message).toBe('Rate limit exceeded');
    });
  });

  describe('_handleAgentEnd', () => {
    it('should emit complete with full accumulated text', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('complete', handler);

      bridge._accumulatedText = 'The full response';

      bridge._handleAgentEnd({});

      expect(handler).toHaveBeenCalledWith({ fullText: 'The full response' });
    });

    it('should reset accumulated text after emitting', () => {
      const bridge = new PiBridge();
      bridge._accumulatedText = 'some text';

      bridge._handleAgentEnd({});

      expect(bridge._accumulatedText).toBe('');
      expect(bridge._inMessage).toBe(false);
    });
  });

  describe('extension_ui_request handling', () => {
    it('should auto-cancel dialog methods (select, confirm, input, editor)', () => {
      const bridge = new PiBridge();
      bridge._process = fakeProc;

      for (const method of ['select', 'confirm', 'input', 'editor']) {
        fakeProc.stdin.write.mockClear();

        bridge._handleLine(JSON.stringify({
          type: 'extension_ui_request',
          method,
          id: `req-${method}`
        }));

        expect(fakeProc.stdin.write).toHaveBeenCalledTimes(1);
        const written = JSON.parse(fakeProc.stdin.write.mock.calls[0][0].trim());
        expect(written.type).toBe('extension_ui_response');
        expect(written.id).toBe(`req-${method}`);
        expect(written.cancelled).toBe(true);
      }
    });

    it('should ignore non-dialog extension_ui_request methods', () => {
      const bridge = new PiBridge();
      bridge._process = fakeProc;

      bridge._handleLine(JSON.stringify({
        type: 'extension_ui_request',
        method: 'notification',
        id: 'req-notif'
      }));

      expect(fakeProc.stdin.write).not.toHaveBeenCalled();
    });
  });

  describe('isReady', () => {
    it('should return false before start', () => {
      const bridge = new PiBridge();
      expect(bridge.isReady()).toBe(false);
    });

    it('should return true after successful start', async () => {
      const bridge = new PiBridge();
      await bridge.start();

      expect(bridge.isReady()).toBe(true);
    });

    it('should return false when closing', async () => {
      const bridge = new PiBridge();
      await bridge.start();

      bridge._closing = true;
      expect(bridge.isReady()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should throw if not ready', async () => {
      const bridge = new PiBridge();
      await expect(bridge.sendMessage('hello')).rejects.toThrow('PiBridge is not ready');
    });

    it('should write prompt command to stdin when ready', async () => {
      const bridge = new PiBridge();
      await bridge.start();

      await bridge.sendMessage('How does this code work?');

      expect(fakeProc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"prompt"')
      );
      expect(fakeProc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('How does this code work?')
      );
    });

    it('should reset accumulated text on new message', async () => {
      const bridge = new PiBridge();
      await bridge.start();

      bridge._accumulatedText = 'leftover from previous turn';
      await bridge.sendMessage('new question');

      expect(bridge._accumulatedText).toBe('');
    });
  });

  describe('error handling', () => {
    it('should emit error on spawn failure after ready', async () => {
      const bridge = new PiBridge();
      await bridge.start();

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      fakeProc.emit('error', new Error('SIGPIPE'));

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.any(Error)
      });
    });

    it('should reject start on spawn error before ready', async () => {
      // Create a fake process that errors synchronously (before setImmediate)
      const badProc = createFakeProcess();
      mockSpawn.mockReturnValueOnce(badProc);

      const bridge = new PiBridge();
      const startPromise = bridge.start();

      // Error fires before the setImmediate callback
      badProc.emit('error', new Error('ENOENT'));

      await expect(startPromise).rejects.toThrow('Failed to start Pi RPC');
    });
  });
});
