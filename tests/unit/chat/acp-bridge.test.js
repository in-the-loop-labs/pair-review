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

const AcpBridge = require('../../../src/chat/acp-bridge');

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
 * Helper to create mock ACP SDK dependencies.
 * Returns { mockConnection, mockDeps, fakeProc } for test assertions.
 */
function createMockDeps(overrides = {}) {
  const fakeProc = createFakeProcess();

  const mockConnection = {
    initialize: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'session-abc-123' }),
    loadSession: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };

  // Must use a real constructor function so `new` works correctly
  function MockClientSideConnection(_factory, _stream) {
    return mockConnection;
  }
  const ClientSideConnectionSpy = vi.fn(MockClientSideConnection);

  const mockAcp = {
    ndJsonStream: vi.fn().mockReturnValue({
      writable: {},
      readable: {},
    }),
    ClientSideConnection: ClientSideConnectionSpy,
    PROTOCOL_VERSION: 1,
  };

  const mockSpawn = vi.fn().mockReturnValue(fakeProc);

  const mockDeps = {
    spawn: mockSpawn,
    acp: mockAcp,
    Writable: { toWeb: vi.fn().mockReturnValue({}) },
    Readable: { toWeb: vi.fn().mockReturnValue({}) },
    ...overrides,
  };

  return { mockConnection, mockAcp, mockDeps, mockSpawn, fakeProc };
}

describe('AcpBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set default options', () => {
      const bridge = new AcpBridge();
      expect(bridge.model).toBeNull();
      expect(bridge.cwd).toBe(process.cwd());
      expect(bridge.systemPrompt).toBeNull();
      expect(bridge.acpCommand).toBe('copilot');
      expect(bridge.acpArgs).toEqual(['--acp', '--stdio']);
      expect(bridge.env).toEqual({});
    });

    it('should accept custom options', () => {
      const bridge = new AcpBridge({
        model: 'gpt-4o',
        cwd: '/tmp/work',
        systemPrompt: 'Be helpful',
        acpCommand: '/usr/local/bin/copilot',
        acpArgs: ['--acp', '--stdio', '--verbose'],
        env: { CUSTOM_VAR: '1' },
      });
      expect(bridge.model).toBe('gpt-4o');
      expect(bridge.cwd).toBe('/tmp/work');
      expect(bridge.systemPrompt).toBe('Be helpful');
      expect(bridge.acpCommand).toBe('/usr/local/bin/copilot');
      expect(bridge.acpArgs).toEqual(['--acp', '--stdio', '--verbose']);
      expect(bridge.env).toEqual({ CUSTOM_VAR: '1' });
    });

    it('should initialize internal state', () => {
      const bridge = new AcpBridge();
      expect(bridge._process).toBeNull();
      expect(bridge._connection).toBeNull();
      expect(bridge._sessionId).toBeNull();
      expect(bridge._ready).toBe(false);
      expect(bridge._closing).toBe(false);
      expect(bridge._accumulatedText).toBe('');
      expect(bridge._inMessage).toBe(false);
      expect(bridge._firstMessage).toBe(true);
    });
  });

  describe('isReady', () => {
    it('should return false before start', () => {
      const bridge = new AcpBridge();
      expect(bridge.isReady()).toBe(false);
    });

    it('should return true after successful start', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();
      expect(bridge.isReady()).toBe(true);
    });

    it('should return false when closing', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();
      bridge._closing = true;
      expect(bridge.isReady()).toBe(false);
    });

    it('should return false when process is null', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();
      bridge._process = null;
      expect(bridge.isReady()).toBe(false);
    });
  });

  describe('isBusy', () => {
    it('should return false when not processing a message', () => {
      const bridge = new AcpBridge();
      expect(bridge.isBusy()).toBe(false);
    });

    it('should return true when processing a message', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      // Make prompt hang so _inMessage stays true
      mockConnection.prompt.mockReturnValue(new Promise(() => {}));
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('hello');
      expect(bridge.isBusy()).toBe(true);
    });
  });

  describe('start()', () => {
    it('should spawn the agent subprocess with correct arguments', async () => {
      const { mockDeps, mockSpawn } = createMockDeps();
      const bridge = new AcpBridge({
        cwd: '/my/repo',
        acpCommand: 'my-agent',
        acpArgs: ['--acp', '--stdio'],
        env: { MY_VAR: 'yes' },
        _deps: mockDeps,
      });

      await bridge.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'my-agent',
        ['--acp', '--stdio'],
        expect.objectContaining({
          cwd: '/my/repo',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );
      // Env should include the custom var
      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env.MY_VAR).toBe('yes');
    });

    it('should create ndJsonStream with process stdin/stdout', async () => {
      const { mockDeps, mockAcp } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      expect(mockDeps.Writable.toWeb).toHaveBeenCalled();
      expect(mockDeps.Readable.toWeb).toHaveBeenCalled();
      expect(mockAcp.ndJsonStream).toHaveBeenCalled();
    });

    it('should create ClientSideConnection with a client handler factory', async () => {
      const { mockDeps, mockAcp } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      expect(mockAcp.ClientSideConnection).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should initialize the connection with protocol version and capabilities', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      expect(mockConnection.initialize).toHaveBeenCalledWith({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'pair-review', version: expect.any(String) },
      });
    });

    it('should create a new session with cwd', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({ cwd: '/work/dir', _deps: mockDeps });
      await bridge.start();

      expect(mockConnection.newSession).toHaveBeenCalledWith({
        cwd: '/work/dir',
        mcpServers: [],
      });
    });

    it('should store the session ID', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      expect(bridge._sessionId).toBe('session-abc-123');
    });

    it('should emit session event once during initialization', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      await bridge.start();

      expect(sessionHandler).toHaveBeenCalledTimes(1);
      expect(sessionHandler).toHaveBeenCalledWith({ sessionId: 'session-abc-123' });
    });

    it('should emit ready event', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      const readyHandler = vi.fn();
      bridge.on('ready', readyHandler);

      await bridge.start();

      expect(readyHandler).toHaveBeenCalledTimes(1);
    });

    it('should throw if already started', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      await expect(bridge.start()).rejects.toThrow('AcpBridge already started');
    });

    it('should reject on spawn error before ready', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      // Make initialization hang so the error fires first
      mockDeps.acp.ClientSideConnection = function () {
        return { initialize: () => new Promise(() => {}) };
      };

      const bridge = new AcpBridge({ _deps: mockDeps });
      const startPromise = bridge.start();

      fakeProc.emit('error', new Error('ENOENT'));

      await expect(startPromise).rejects.toThrow('Failed to start ACP agent');
    });

    it('should reject on process exit before ready', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      mockDeps.acp.ClientSideConnection = function () {
        return { initialize: () => new Promise(() => {}) };
      };

      const bridge = new AcpBridge({ _deps: mockDeps });
      // Add error listener to prevent unhandled error from the 'close' handler
      bridge.on('error', () => {});
      const startPromise = bridge.start();

      fakeProc.emit('close', 1, null);

      await expect(startPromise).rejects.toThrow('ACP agent exited before ready');
    });

    it('should use loadSession when resumeSessionId is provided', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({
        resumeSessionId: 'prev-session-xyz',
        cwd: '/my/repo',
        _deps: mockDeps,
      });
      await bridge.start();

      expect(mockConnection.loadSession).toHaveBeenCalledWith({
        sessionId: 'prev-session-xyz',
        cwd: '/my/repo',
        mcpServers: [],
      });
      expect(mockConnection.newSession).not.toHaveBeenCalled();
      expect(bridge._sessionId).toBe('prev-session-xyz');
    });

    it('should use newSession when resumeSessionId is not provided', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      expect(mockConnection.newSession).toHaveBeenCalled();
      expect(mockConnection.loadSession).not.toHaveBeenCalled();
    });

    it('should reject on ACP initialization failure', async () => {
      const { mockDeps } = createMockDeps();
      mockDeps.acp.ClientSideConnection = function () {
        return {
          initialize: vi.fn().mockRejectedValue(new Error('handshake failed')),
        };
      };

      const bridge = new AcpBridge({ _deps: mockDeps });
      await expect(bridge.start()).rejects.toThrow('ACP initialization failed: handshake failed');
    });
  });

  describe('sendMessage()', () => {
    it('should throw if not ready', async () => {
      const bridge = new AcpBridge();
      await expect(bridge.sendMessage('hello')).rejects.toThrow('AcpBridge is not ready');
    });

    it('should call connection.prompt with the message', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('How does this work?');

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'session-abc-123',
        prompt: [{ type: 'text', text: 'How does this work?' }],
      });
    });

    it('should return immediately (fire-and-forget)', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      // Make prompt never resolve
      mockConnection.prompt.mockReturnValue(new Promise(() => {}));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      // This should not block
      bridge.sendMessage('hello');
      expect(bridge._inMessage).toBe(true);
    });

    it('should reset accumulated text on new message', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      mockConnection.prompt.mockReturnValue(new Promise(() => {}));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      bridge._accumulatedText = 'leftover from previous turn';
      bridge.sendMessage('new question');

      expect(bridge._accumulatedText).toBe('');
    });

    it('should set _inMessage to true', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      mockConnection.prompt.mockReturnValue(new Promise(() => {}));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('hello');
      expect(bridge._inMessage).toBe(true);
    });

    it('should prepend system prompt to first message only', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({
        systemPrompt: 'You are a reviewer',
        _deps: mockDeps,
      });
      await bridge.start();

      bridge.sendMessage('First message');

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'session-abc-123',
        prompt: [{ type: 'text', text: 'You are a reviewer\n\nFirst message' }],
      });

      // Second message should NOT include system prompt
      bridge.sendMessage('Second message');

      expect(mockConnection.prompt).toHaveBeenLastCalledWith({
        sessionId: 'session-abc-123',
        prompt: [{ type: 'text', text: 'Second message' }],
      });
    });

    it('should not prepend system prompt when none is set', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('Hello');

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'session-abc-123',
        prompt: [{ type: 'text', text: 'Hello' }],
      });
    });

    it('should emit complete when prompt resolves', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      let resolvePrompt;
      mockConnection.prompt.mockReturnValue(new Promise((r) => { resolvePrompt = r; }));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const completeHandler = vi.fn();
      bridge.on('complete', completeHandler);

      bridge.sendMessage('hello');
      bridge._accumulatedText = 'The full response';

      resolvePrompt({ stopReason: 'end_turn' });

      // Wait for microtask
      await new Promise((r) => setTimeout(r, 0));

      expect(completeHandler).toHaveBeenCalledWith({ fullText: 'The full response' });
      expect(bridge._inMessage).toBe(false);
      expect(bridge._accumulatedText).toBe('');
    });

    it('should emit error when prompt rejects', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      let rejectPrompt;
      mockConnection.prompt.mockReturnValue(new Promise((_r, rej) => { rejectPrompt = rej; }));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      bridge.sendMessage('hello');

      rejectPrompt(new Error('Rate limit'));

      // Wait for microtask
      await new Promise((r) => setTimeout(r, 0));

      expect(errorHandler).toHaveBeenCalledWith({ error: expect.any(Error) });
      expect(errorHandler.mock.calls[0][0].error.message).toBe('Rate limit');
      expect(bridge._inMessage).toBe(false);
    });

    it('should not emit session event on sendMessage (fires once during start)', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      mockConnection.prompt.mockReturnValue(new Promise(() => {}));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      bridge.sendMessage('hello');

      // Session event should NOT fire on sendMessage — it fires once during _initializeConnection
      expect(sessionHandler).not.toHaveBeenCalled();
    });
  });

  describe('abort()', () => {
    it('should call connection.cancel with sessionId', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.abort();

      expect(mockConnection.cancel).toHaveBeenCalledWith({ sessionId: 'session-abc-123' });
    });

    it('should not throw when not ready', () => {
      const bridge = new AcpBridge();
      expect(() => bridge.abort()).not.toThrow();
    });

    it('should not throw when sessionId is null', async () => {
      const { mockDeps } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();
      bridge._sessionId = null;

      expect(() => bridge.abort()).not.toThrow();
    });

    it('should catch and log cancel errors', async () => {
      const { mockDeps, mockConnection } = createMockDeps();
      mockConnection.cancel.mockRejectedValue(new Error('cancel failed'));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      // Should not throw
      bridge.abort();

      // Wait for the rejection to be caught
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  describe('close()', () => {
    it('should do nothing if process is null', async () => {
      const bridge = new AcpBridge();
      await bridge.close(); // Should resolve without error
    });

    it('should set _closing to true and remove all listeners', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const handler = vi.fn();
      bridge.on('delta', handler);

      const closePromise = bridge.close();

      expect(bridge._closing).toBe(true);

      // Simulate process close
      fakeProc.emit('close', 0, null);
      await closePromise;

      expect(bridge.listenerCount('delta')).toBe(0);
    });

    it('should cancel in-flight prompt before tearing down', async () => {
      const { mockDeps, mockConnection, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const closePromise = bridge.close();

      expect(mockConnection.cancel).toHaveBeenCalledWith({ sessionId: 'session-abc-123' });

      fakeProc.emit('close', 0, 'SIGTERM');
      await closePromise;
    });

    it('should handle cancel error gracefully during close', async () => {
      const { mockDeps, mockConnection, fakeProc } = createMockDeps();
      mockConnection.cancel.mockRejectedValue(new Error('already dead'));

      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const closePromise = bridge.close();

      fakeProc.emit('close', 0, 'SIGTERM');
      await closePromise; // Should not throw
    });

    it('should send SIGTERM to the process', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const closePromise = bridge.close();

      // Let the await cancel() resolve before checking SIGTERM
      await new Promise((r) => setTimeout(r, 0));

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

      fakeProc.emit('close', 0, 'SIGTERM');
      await closePromise;
    });

    it('should force kill with SIGKILL after timeout', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      // Use fake timers from the start, but flush microtasks for cancel()
      vi.useFakeTimers();
      try {
        const closePromise = bridge.close();

        // Flush microtasks so the awaited cancel() resolves and
        // close() progresses to the setTimeout/SIGTERM phase
        await vi.advanceTimersByTimeAsync(0);

        // Process does not exit, advance past 3s timeout
        await vi.advanceTimersByTimeAsync(3000);

        expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

        fakeProc.emit('close', 0, 'SIGKILL');
        await closePromise;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('_handleSessionUpdate()', () => {
    it('should ignore updates with no update property', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);
      bridge.on('tool_use', handler);
      bridge.on('status', handler);

      bridge._handleSessionUpdate({});
      bridge._handleSessionUpdate({ update: null });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit delta on agent_message_chunk with text content', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello world' },
        },
      });

      expect(handler).toHaveBeenCalledWith({ text: 'Hello world' });
    });

    it('should accumulate text from agent_message_chunk', () => {
      const bridge = new AcpBridge();

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello ' },
        },
      });
      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        },
      });

      expect(bridge._accumulatedText).toBe('Hello world');
    });

    it('should not emit delta for non-text content', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'base64...' },
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit delta when content is missing', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleSessionUpdate({
        update: { sessionUpdate: 'agent_message_chunk' },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not emit delta when text is empty', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should emit tool_use with status start on tool_call', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Read file',
          kind: 'read',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-1',
        toolName: 'Read file',
        status: 'start',
        kind: 'read',
      });
    });

    it('should emit tool_use with status update on tool_call_update with in_progress', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          title: 'Read file',
          status: 'in_progress',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-1',
        toolName: 'Read file',
        status: 'update',
      });
    });

    it('should emit tool_use with status end on tool_call_update with completed', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-2',
          title: 'Write file',
          status: 'completed',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-2',
        toolName: 'Write file',
        status: 'end',
      });
    });

    it('should emit tool_use with status end on tool_call_update with failed', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-3',
          title: 'Execute command',
          status: 'failed',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-3',
        toolName: 'Execute command',
        status: 'end',
      });
    });

    it('should default tool_call_update with unknown status to update', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-4',
          title: 'Some tool',
          status: 'pending',
        },
      });

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-4',
        toolName: 'Some tool',
        status: 'update',
      });
    });

    it('should emit status working on plan update', () => {
      const bridge = new AcpBridge();
      const handler = vi.fn();
      bridge.on('status', handler);

      bridge._handleSessionUpdate({
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Step 1', priority: 'high', status: 'pending' }],
        },
      });

      expect(handler).toHaveBeenCalledWith({ status: 'working' });
    });

    it('should not throw on unknown sessionUpdate types', () => {
      const bridge = new AcpBridge();

      expect(() => {
        bridge._handleSessionUpdate({
          update: { sessionUpdate: 'usage_update', totalTokens: 100 },
        });
      }).not.toThrow();
    });
  });

  describe('_handlePermission()', () => {
    it('should select allow_once option when available', () => {
      const bridge = new AcpBridge();
      const result = bridge._handlePermission({
        options: [
          { kind: 'reject_once', name: 'Deny', optionId: 'opt-deny' },
          { kind: 'allow_once', name: 'Allow', optionId: 'opt-allow' },
          { kind: 'allow_always', name: 'Always allow', optionId: 'opt-always' },
        ],
      });

      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-allow' },
      });
    });

    it('should fall back to allow_always when allow_once is missing', () => {
      const bridge = new AcpBridge();
      const result = bridge._handlePermission({
        options: [
          { kind: 'reject_once', name: 'Deny', optionId: 'opt-deny' },
          { kind: 'allow_always', name: 'Always allow', optionId: 'opt-always' },
        ],
      });

      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-always' },
      });
    });

    it('should return cancelled when no allow option exists', () => {
      const bridge = new AcpBridge();
      const result = bridge._handlePermission({
        options: [
          { kind: 'reject_once', name: 'Deny', optionId: 'opt-deny' },
          { kind: 'reject_always', name: 'Always deny', optionId: 'opt-deny-always' },
        ],
      });

      expect(result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('should return cancelled when options array is empty', () => {
      const bridge = new AcpBridge();
      const result = bridge._handlePermission({ options: [] });

      expect(result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('should handle missing options property', () => {
      const bridge = new AcpBridge();
      const result = bridge._handlePermission({});

      expect(result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });
  });

  describe('error handling', () => {
    it('should emit error on process error after ready', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      fakeProc.emit('error', new Error('SIGPIPE'));

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.any(Error),
      });
    });

    it('should emit error and close on unexpected process exit', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      const closeHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.on('close', closeHandler);

      fakeProc.emit('close', 1, null);

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.objectContaining({
          message: expect.stringContaining('ACP agent exited'),
        }),
      });
      expect(closeHandler).toHaveBeenCalled();
      expect(bridge.isReady()).toBe(false);
    });

    it('should not emit error on expected close (closing flag)', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      bridge._closing = true;
      fakeProc.emit('close', 0, 'SIGTERM');

      expect(errorHandler).not.toHaveBeenCalled();
    });
  });

  describe('client handler integration', () => {
    it('should wire sessionUpdate through the client handler factory', async () => {
      const { mockDeps, mockAcp } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      // Extract the client handler from the factory that was passed to ClientSideConnection
      const factory = mockAcp.ClientSideConnection.mock.calls[0][0];
      const handler = factory({ name: 'test-agent' });

      const deltaHandler = vi.fn();
      bridge.on('delta', deltaHandler);

      handler.sessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'From factory' },
        },
      });

      expect(deltaHandler).toHaveBeenCalledWith({ text: 'From factory' });
    });

    it('should wire requestPermission through the client handler factory', async () => {
      const { mockDeps, mockAcp } = createMockDeps();
      const bridge = new AcpBridge({ _deps: mockDeps });
      await bridge.start();

      const factory = mockAcp.ClientSideConnection.mock.calls[0][0];
      const handler = factory({ name: 'test-agent' });

      const result = handler.requestPermission({
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'opt-1' },
        ],
      });

      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-1' },
      });
    });
  });
});
