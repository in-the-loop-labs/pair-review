// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const ClaudeCodeBridge = require('../../../src/chat/claude-code-bridge');

/**
 * Helper to create a fake child process with EventEmitter + streams.
 */
function createFakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdin.writable = true;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 99999;
  return proc;
}

/**
 * Helper to create mock dependencies for ClaudeCodeBridge.
 * Returns { mockDeps, mockSpawn, mockCreateInterface, fakeProc, rlEmitter }.
 */
function createMockDeps(overrides = {}) {
  const fakeProc = createFakeProcess();
  const rlEmitter = new EventEmitter();
  rlEmitter.close = vi.fn();

  const mockSpawn = vi.fn().mockReturnValue(fakeProc);
  const mockCreateInterface = vi.fn().mockReturnValue(rlEmitter);

  const mockDeps = {
    spawn: mockSpawn,
    createInterface: mockCreateInterface,
    ...overrides,
  };

  return { mockDeps, mockSpawn, mockCreateInterface, fakeProc, rlEmitter };
}

/**
 * Simulate receiving a line of NDJSON from stdout (via the readline emitter).
 */
function simulateLine(rlEmitter, obj) {
  rlEmitter.emit('line', JSON.stringify(obj));
}

/**
 * Start a bridge. With --input-format stream-json, the CLI doesn't emit
 * system/init until the first user message, so start() resolves immediately
 * after spawning. Optionally simulate system/init to set the session ID.
 */
async function startBridge(bridge, rlEmitter, { withInit = false } = {}) {
  await bridge.start();
  if (withInit) {
    simulateLine(rlEmitter, { type: 'system', subtype: 'init', session_id: 'session-abc-123' });
  }
}

describe('ClaudeCodeBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set default options', () => {
      const bridge = new ClaudeCodeBridge();
      expect(bridge.model).toBeNull();
      expect(bridge.cwd).toBe(process.cwd());
      expect(bridge.systemPrompt).toBeNull();
      expect(bridge.claudeCommand).toBe('claude');
      expect(bridge.env).toEqual({});
    });

    it('should accept custom options', () => {
      const bridge = new ClaudeCodeBridge({
        model: 'claude-sonnet-4-6',
        cwd: '/tmp/work',
        systemPrompt: 'Be helpful',
        claudeCommand: '/usr/local/bin/claude',
        env: { CUSTOM_VAR: '1' },
      });
      expect(bridge.model).toBe('claude-sonnet-4-6');
      expect(bridge.cwd).toBe('/tmp/work');
      expect(bridge.systemPrompt).toBe('Be helpful');
      expect(bridge.claudeCommand).toBe('/usr/local/bin/claude');
      expect(bridge.env).toEqual({ CUSTOM_VAR: '1' });
    });

    it('should initialize internal state', () => {
      const bridge = new ClaudeCodeBridge();
      expect(bridge._process).toBeNull();
      expect(bridge._ready).toBe(false);
      expect(bridge._closing).toBe(false);
      expect(bridge._accumulatedText).toBe('');
      expect(bridge._inMessage).toBe(false);
      expect(bridge._firstMessage).toBe(true);
      expect(bridge._sessionId).toBeNull();
      expect(bridge._activeTools).toBeInstanceOf(Map);
      expect(bridge._activeTools.size).toBe(0);
    });

    it('should respect PAIR_REVIEW_CLAUDE_CMD env var override', () => {
      const original = process.env.PAIR_REVIEW_CLAUDE_CMD;
      process.env.PAIR_REVIEW_CLAUDE_CMD = '/custom/claude-bin';
      try {
        const bridge = new ClaudeCodeBridge();
        expect(bridge.claudeCommand).toBe('/custom/claude-bin');
      } finally {
        if (original === undefined) {
          delete process.env.PAIR_REVIEW_CLAUDE_CMD;
        } else {
          process.env.PAIR_REVIEW_CLAUDE_CMD = original;
        }
      }
    });

    it('should set _firstMessage to false when resumeSessionId is provided', () => {
      const bridge = new ClaudeCodeBridge({ resumeSessionId: 'prev-session' });
      expect(bridge._firstMessage).toBe(false);
    });
  });

  describe('isReady', () => {
    it('should return false before start', () => {
      const bridge = new ClaudeCodeBridge();
      expect(bridge.isReady()).toBe(false);
    });

    it('should return true after successful start', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);
      expect(bridge.isReady()).toBe(true);
    });

    it('should return false when closing', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);
      bridge._closing = true;
      expect(bridge.isReady()).toBe(false);
    });

    it('should return false when process is null', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);
      bridge._process = null;
      expect(bridge.isReady()).toBe(false);
    });
  });

  describe('isBusy', () => {
    it('should return false when not processing a message', () => {
      const bridge = new ClaudeCodeBridge();
      expect(bridge.isBusy()).toBe(false);
    });

    it('should return true after sendMessage is called', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      bridge.sendMessage('hello');
      expect(bridge.isBusy()).toBe(true);
    });
  });

  describe('start()', () => {
    it('should spawn with correct args', async () => {
      const { mockDeps, mockSpawn, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({
        cwd: '/my/repo',
        claudeCommand: 'my-claude',
        env: { MY_VAR: 'yes' },
        _deps: mockDeps,
      });

      await startBridge(bridge, rlEmitter);

      expect(mockSpawn).toHaveBeenCalledWith(
        'my-claude',
        expect.arrayContaining([
          '-p', '',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--allowedTools',
          '--settings', '{"disableAllHooks":true}',
        ]),
        expect.objectContaining({
          cwd: '/my/repo',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );

      // Env should include the custom var
      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env.MY_VAR).toBe('yes');
    });

    it('should create readline on stdout', async () => {
      const { mockDeps, mockCreateInterface, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      expect(mockCreateInterface).toHaveBeenCalledWith(
        expect.objectContaining({ crlfDelay: Infinity })
      );
    });

    it('should emit ready immediately on start', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      const readyHandler = vi.fn();
      bridge.on('ready', readyHandler);

      await startBridge(bridge, rlEmitter);

      expect(readyHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit session event with sessionId when system/init arrives', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      await startBridge(bridge, rlEmitter);

      // Session ID is null before init
      expect(bridge._sessionId).toBeNull();

      // Simulate init arriving with first response
      simulateLine(rlEmitter, { type: 'system', subtype: 'init', session_id: 'session-abc-123' });

      expect(sessionHandler).toHaveBeenCalledTimes(1);
      expect(sessionHandler).toHaveBeenCalledWith({ sessionId: 'session-abc-123' });
      expect(bridge._sessionId).toBe('session-abc-123');
    });

    it('should not have CLAUDECODE in spawned env', async () => {
      const { mockDeps, mockSpawn, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env.CLAUDECODE).toBeUndefined();
    });

    it('should include --resume <id> in args when resuming', async () => {
      const { mockDeps, mockSpawn, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({
        resumeSessionId: 'prev-session-xyz',
        _deps: mockDeps,
      });
      await startBridge(bridge, rlEmitter);

      const args = mockSpawn.mock.calls[0][1];
      expect(args[0]).toBe('--resume');
      expect(args[1]).toBe('prev-session-xyz');
    });

    it('should include --model <id> in args when model is set', async () => {
      const { mockDeps, mockSpawn, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({
        model: 'claude-opus-4-6',
        _deps: mockDeps,
      });
      await startBridge(bridge, rlEmitter);

      const args = mockSpawn.mock.calls[0][1];
      expect(args).toContain('--model');
      expect(args).toContain('claude-opus-4-6');
    });

    it('should throw if already started', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      await expect(bridge.start()).rejects.toThrow('ClaudeCodeBridge already started');
    });

    it('should emit error on spawn failure (e.g., ENOENT)', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      fakeProc.emit('error', new Error('ENOENT'));

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.any(Error),
      });
    });

    it('should emit error on unexpected process exit after start', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      fakeProc.emit('close', 1, null);

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.objectContaining({
          message: expect.stringContaining('Claude CLI exited'),
        }),
      });
      expect(bridge.isReady()).toBe(false);
    });
  });

  describe('_handleMessage() / message routing', () => {
    it('should emit delta with text on stream_event content_block_delta text_delta', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const deltaHandler = vi.fn();
      bridge.on('delta', deltaHandler);

      simulateLine(rlEmitter, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello world' },
        },
      });

      expect(deltaHandler).toHaveBeenCalledWith({ text: 'Hello world' });
    });

    it('should accumulate text from multiple text_delta events', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      bridge._inMessage = true;

      simulateLine(rlEmitter, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' },
        },
      });
      simulateLine(rlEmitter, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' },
        },
      });

      expect(bridge._accumulatedText).toBe('Hello world');
    });

    it('should emit tool_use start on stream_event content_block_start tool_use', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const toolHandler = vi.fn();
      bridge.on('tool_use', toolHandler);

      simulateLine(rlEmitter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tc-1', name: 'Read' },
        },
      });

      expect(toolHandler).toHaveBeenCalledWith({
        toolCallId: 'tc-1',
        toolName: 'Read',
        status: 'start',
      });

      // Should also track the tool in _activeTools
      expect(bridge._activeTools.get('tc-1')).toBe('Read');
    });

    it('should emit tool_use update on tool_progress', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const toolHandler = vi.fn();
      bridge.on('tool_use', toolHandler);

      simulateLine(rlEmitter, {
        type: 'tool_progress',
        tool_use_id: 'tc-1',
        tool_name: 'Read',
      });

      expect(toolHandler).toHaveBeenCalledWith({
        toolCallId: 'tc-1',
        toolName: 'Read',
        status: 'update',
      });
    });

    it('should emit status working on assistant message', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const statusHandler = vi.fn();
      bridge.on('status', statusHandler);

      simulateLine(rlEmitter, { type: 'assistant', message: {} });

      expect(statusHandler).toHaveBeenCalledWith({ status: 'working' });
    });

    it('should emit status working on system status', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      // Clear handlers from the init status
      const statusHandler = vi.fn();
      bridge.on('status', statusHandler);

      simulateLine(rlEmitter, { type: 'system', subtype: 'status' });

      expect(statusHandler).toHaveBeenCalledWith({ status: 'working' });
    });

    it('should emit complete with accumulated text on result success', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const completeHandler = vi.fn();
      bridge.on('complete', completeHandler);

      // Simulate some deltas then result
      bridge._inMessage = true;
      bridge._accumulatedText = 'The full response';

      simulateLine(rlEmitter, { type: 'result', subtype: 'success' });

      expect(completeHandler).toHaveBeenCalledWith({ fullText: 'The full response' });
      expect(bridge._inMessage).toBe(false);
      expect(bridge._accumulatedText).toBe('');
    });

    it('should clear _activeTools on result message', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      // Populate _activeTools as if a tool_use started but never got a result
      bridge._activeTools.set('orphan-tool', 'Grep');
      bridge._inMessage = true;

      simulateLine(rlEmitter, { type: 'result', subtype: 'success' });

      expect(bridge._activeTools.size).toBe(0);
    });

    it('should emit error (not complete) on result error with errors array', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const completeHandler = vi.fn();
      const errorHandler = vi.fn();
      bridge.on('complete', completeHandler);
      bridge.on('error', errorHandler);

      bridge._inMessage = true;
      bridge._accumulatedText = 'partial';

      simulateLine(rlEmitter, { type: 'result', subtype: 'error_max_turns', errors: ['Max turns reached'] });

      expect(completeHandler).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.objectContaining({ message: 'Max turns reached' }),
      });
      expect(bridge._inMessage).toBe(false);
    });

    it('should fall back to subtype when errors array is empty on result error', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const completeHandler = vi.fn();
      const errorHandler = vi.fn();
      bridge.on('complete', completeHandler);
      bridge.on('error', errorHandler);

      bridge._inMessage = true;

      simulateLine(rlEmitter, { type: 'result', subtype: 'error_unknown' });

      expect(completeHandler).not.toHaveBeenCalled();
      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.objectContaining({ message: 'error_unknown' }),
      });
    });

    it('should emit tool_use end with resolved toolName from _activeTools map', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const toolHandler = vi.fn();
      bridge.on('tool_use', toolHandler);

      // Simulate tool starts so the map is populated
      simulateLine(rlEmitter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool123', name: 'Read' },
        },
      });
      simulateLine(rlEmitter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool456', name: 'Bash' },
        },
      });

      toolHandler.mockClear();

      // Now simulate tool results
      simulateLine(rlEmitter, {
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool123' },
          { type: 'tool_result', tool_use_id: 'tool456' },
        ],
      });

      expect(toolHandler).toHaveBeenCalledTimes(2);
      expect(toolHandler).toHaveBeenCalledWith({
        toolCallId: 'tool123',
        toolName: 'Read',
        status: 'end',
      });
      expect(toolHandler).toHaveBeenCalledWith({
        toolCallId: 'tool456',
        toolName: 'Bash',
        status: 'end',
      });

      // Map entries should be cleaned up
      expect(bridge._activeTools.size).toBe(0);
    });

    it('should emit tool_use end with null toolName when tool_use_id is unknown', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const toolHandler = vi.fn();
      bridge.on('tool_use', toolHandler);

      // No prior content_block_start, so the map has no entry
      simulateLine(rlEmitter, {
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'unknown-id' },
        ],
      });

      expect(toolHandler).toHaveBeenCalledWith({
        toolCallId: 'unknown-id',
        toolName: null,
        status: 'end',
      });
    });

    it('should ignore user messages without content array', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const toolHandler = vi.fn();
      bridge.on('tool_use', toolHandler);

      simulateLine(rlEmitter, { type: 'user', content: 'plain text' });

      expect(toolHandler).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage()', () => {
    it('should throw if not ready', async () => {
      const bridge = new ClaudeCodeBridge();
      await expect(bridge.sendMessage('hello')).rejects.toThrow('ClaudeCodeBridge is not ready');
    });

    it('should throw if busy', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      bridge._inMessage = true;
      await expect(bridge.sendMessage('hello')).rejects.toThrow('ClaudeCodeBridge is busy');
    });

    it('should write correct NDJSON to stdin', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter, { withInit: true });

      const chunks = [];
      fakeProc.stdin.on('data', (chunk) => chunks.push(chunk.toString()));

      await bridge.sendMessage('How does this work?');

      const written = JSON.parse(chunks[0].trim());
      expect(written).toEqual({
        type: 'user',
        message: { role: 'user', content: 'How does this work?' },
        session_id: 'session-abc-123',
        parent_tool_use_id: null,
      });
    });

    it('should use empty session_id before init arrives', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const chunks = [];
      fakeProc.stdin.on('data', (chunk) => chunks.push(chunk.toString()));

      await bridge.sendMessage('First message');

      const written = JSON.parse(chunks[0].trim());
      expect(written.session_id).toBe('');
    });

    it('should reset accumulated text', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      bridge._accumulatedText = 'leftover from previous turn';
      await bridge.sendMessage('new question');

      expect(bridge._accumulatedText).toBe('');
    });

    it('should set _inMessage to true', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      await bridge.sendMessage('hello');
      expect(bridge._inMessage).toBe(true);
    });

    it('should prepend system prompt to first message only', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({
        systemPrompt: 'You are a reviewer',
        _deps: mockDeps,
      });
      await startBridge(bridge, rlEmitter);

      const chunks = [];
      fakeProc.stdin.on('data', (chunk) => chunks.push(chunk.toString()));

      await bridge.sendMessage('First message');

      const firstWritten = JSON.parse(chunks[0].trim());
      expect(firstWritten.message.content).toBe('You are a reviewer\n\nFirst message');

      // Reset _inMessage so second message can be sent
      bridge._inMessage = false;
      chunks.length = 0;

      await bridge.sendMessage('Second message');

      const secondWritten = JSON.parse(chunks[0].trim());
      expect(secondWritten.message.content).toBe('Second message');
    });

    it('should not prepend system prompt when none is set', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const chunks = [];
      fakeProc.stdin.on('data', (chunk) => chunks.push(chunk.toString()));

      await bridge.sendMessage('Hello');

      const written = JSON.parse(chunks[0].trim());
      expect(written.message.content).toBe('Hello');
    });
  });

  describe('abort()', () => {
    it('should write interrupt control_request to stdin', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter, { withInit: true });

      const chunks = [];
      fakeProc.stdin.on('data', (chunk) => chunks.push(chunk.toString()));

      bridge.abort();

      expect(chunks.length).toBeGreaterThan(0);
      const written = JSON.parse(chunks[0].trim());
      expect(written.type).toBe('control_request');
      expect(written.request).toEqual({ subtype: 'interrupt' });
      expect(written.request_id).toBeDefined();
    });

    it('should do nothing when not ready', () => {
      const bridge = new ClaudeCodeBridge();
      expect(() => bridge.abort()).not.toThrow();
    });

    it('should do nothing when no sessionId', async () => {
      const { mockDeps, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);
      bridge._sessionId = null;

      expect(() => bridge.abort()).not.toThrow();
    });
  });

  describe('close()', () => {
    it('should do nothing if process is null', async () => {
      const bridge = new ClaudeCodeBridge();
      await bridge.close(); // Should resolve without error
    });

    it('should set _closing and remove listeners', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const handler = vi.fn();
      bridge.on('delta', handler);

      const closePromise = bridge.close();

      expect(bridge._closing).toBe(true);

      fakeProc.emit('close', 0, null);
      await closePromise;

      expect(bridge.listenerCount('delta')).toBe(0);
    });

    it('should close readline', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const closePromise = bridge.close();

      expect(rlEmitter.close).toHaveBeenCalled();

      fakeProc.emit('close', 0, null);
      await closePromise;
    });

    it('should end stdin', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const endSpy = vi.spyOn(fakeProc.stdin, 'end');

      const closePromise = bridge.close();

      expect(endSpy).toHaveBeenCalled();

      fakeProc.emit('close', 0, null);
      await closePromise;
    });

    it('should send SIGTERM', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const closePromise = bridge.close();

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

      fakeProc.emit('close', 0, 'SIGTERM');
      await closePromise;
    });

    it('should force kill with SIGKILL after timeout', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      vi.useFakeTimers();
      try {
        const closePromise = bridge.close();

        // Process does not exit, advance past 3s timeout
        await vi.advanceTimersByTimeAsync(3000);

        expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

        fakeProc.emit('close', 0, 'SIGKILL');
        await closePromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should resolve on close event', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const closePromise = bridge.close();
      fakeProc.emit('close', 0, 'SIGTERM');

      await expect(closePromise).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should emit error on process error after ready', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      fakeProc.emit('error', new Error('SIGPIPE'));

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.any(Error),
      });
    });

    it('should not emit error on expected close (closing flag)', async () => {
      const { mockDeps, fakeProc, rlEmitter } = createMockDeps();
      const bridge = new ClaudeCodeBridge({ _deps: mockDeps });
      await startBridge(bridge, rlEmitter);

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      bridge._closing = true;
      fakeProc.emit('close', 0, 'SIGTERM');

      expect(errorHandler).not.toHaveBeenCalled();
    });
  });
});
