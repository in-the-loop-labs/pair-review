// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createInterface } from 'readline';

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

const CodexBridge = require('../../../src/chat/codex-bridge');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fake child process with EventEmitter + PassThrough streams.
 */
function createFakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdin.writable = true;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 77777;
  return proc;
}

/**
 * Create mock dependencies for the CodexBridge `_deps` DI.
 * Returns { fakeProc, mockDeps, mockSpawn }.
 */
function createMockDeps(overrides = {}) {
  const fakeProc = createFakeProcess();
  const mockSpawn = vi.fn().mockReturnValue(fakeProc);

  // Use real readline.createInterface backed by the fake stdout
  const mockCreateInterface = (opts) => createInterface(opts);

  const mockDeps = {
    spawn: mockSpawn,
    createInterface: mockCreateInterface,
    ...overrides,
  };

  return { fakeProc, mockDeps, mockSpawn };
}

/**
 * Listen on the fake process stdin for JSON-RPC requests and auto-respond
 * to initialize, thread/start, and thread/resume. Returns the readline
 * instance for cleanup.
 */
function setupHandshake(fakeProc, options = {}) {
  const threadId = options.threadId || 'test-thread-123';
  const turnStartResult = options.turnStartResult || { turnId: 'turn-001' };
  const rl = createInterface({ input: fakeProc.stdin });

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    // Only respond to requests (have id + method)
    if (msg.id == null || !msg.method) return;

    if (msg.method === 'initialize') {
      sendResponse(fakeProc, msg.id, {
        serverInfo: { name: 'codex-app-server', version: '1.0.0' },
        capabilities: {},
      });
    } else if (msg.method === 'thread/start') {
      sendResponse(fakeProc, msg.id, { thread: { id: threadId } });
    } else if (msg.method === 'thread/resume') {
      // thread/resume returns flat { threadId } per Codex protocol (unlike thread/start's nested shape)
      sendResponse(fakeProc, msg.id, { threadId: msg.params?.threadId || threadId });
    } else if (msg.method === 'turn/start') {
      // Return turn id so the bridge can track the active turn
      sendResponse(fakeProc, msg.id, turnStartResult);
    } else if (msg.method === 'turn/interrupt') {
      sendResponse(fakeProc, msg.id, {});
    }
  });

  return rl;
}

/**
 * Write a JSON-RPC notification (no id) to the fake process stdout.
 */
function sendNotification(fakeProc, method, params = {}) {
  const msg = { jsonrpc: '2.0', method, params };
  fakeProc.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Write a JSON-RPC response to the fake process stdout.
 */
function sendResponse(fakeProc, id, result) {
  const msg = { jsonrpc: '2.0', id, result };
  fakeProc.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Write a JSON-RPC error response to the fake process stdout.
 */
function sendErrorResponse(fakeProc, id, code, message) {
  const msg = { jsonrpc: '2.0', id, error: { code, message } };
  fakeProc.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Write a JSON-RPC request FROM the server to the fake process stdout.
 */
function sendServerRequest(fakeProc, method, params, id) {
  const msg = { jsonrpc: '2.0', id, method, params };
  fakeProc.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Collect all lines written to stdin as parsed JSON objects.
 */
function collectStdinMessages(fakeProc) {
  const messages = [];
  const rl = createInterface({ input: fakeProc.stdin });
  rl.on('line', (line) => {
    try { messages.push(JSON.parse(line)); } catch { /* ignore */ }
  });
  return { messages, rl };
}

/**
 * Wait for a small delay to allow async processing.
 */
function tick(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexBridge', () => {
  let handshakeRl;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (handshakeRl) {
      handshakeRl.close();
      handshakeRl = null;
    }
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should set default options', () => {
      const bridge = new CodexBridge();
      expect(bridge.model).toBeNull();
      expect(bridge.cwd).toBe(process.cwd());
      expect(bridge.systemPrompt).toBeNull();
      expect(bridge.codexCommand).toBe('codex');
      expect(bridge.approvalPolicy).toBe('never');
      expect(bridge.sandbox).toBe('workspace-write');
      expect(bridge.sandboxPolicy).toEqual({
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      });
    });

    it('should accept custom options', () => {
      const bridge = new CodexBridge({
        model: 'o4-mini',
        cwd: '/tmp/work',
        systemPrompt: 'Be helpful',
        codexCommand: '/usr/local/bin/codex',
        env: { CUSTOM_VAR: '1' },
        sandbox: 'read-only',
      });
      expect(bridge.model).toBe('o4-mini');
      expect(bridge.cwd).toBe('/tmp/work');
      expect(bridge.systemPrompt).toBe('Be helpful');
      expect(bridge.codexCommand).toBe('/usr/local/bin/codex');
      expect(bridge.approvalPolicy).toBe('never');
      expect(bridge.sandbox).toBe('read-only');
      expect(bridge.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true });
    });

    it('should use PAIR_REVIEW_CODEX_CMD env var when set', () => {
      const origEnv = process.env.PAIR_REVIEW_CODEX_CMD;
      try {
        process.env.PAIR_REVIEW_CODEX_CMD = '/custom/codex';
        const bridge = new CodexBridge();
        expect(bridge.codexCommand).toBe('/custom/codex');
      } finally {
        if (origEnv === undefined) {
          delete process.env.PAIR_REVIEW_CODEX_CMD;
        } else {
          process.env.PAIR_REVIEW_CODEX_CMD = origEnv;
        }
      }
    });

    it('should prefer explicit codexCommand over env var', () => {
      const origEnv = process.env.PAIR_REVIEW_CODEX_CMD;
      try {
        process.env.PAIR_REVIEW_CODEX_CMD = '/env/codex';
        const bridge = new CodexBridge({ codexCommand: '/explicit/codex' });
        expect(bridge.codexCommand).toBe('/explicit/codex');
      } finally {
        if (origEnv === undefined) {
          delete process.env.PAIR_REVIEW_CODEX_CMD;
        } else {
          process.env.PAIR_REVIEW_CODEX_CMD = origEnv;
        }
      }
    });

    it('should accept custom codexArgs option', () => {
      const bridge = new CodexBridge({ codexArgs: ['app-server', '--verbose'] });
      expect(bridge.codexArgs).toEqual(['app-server', '--verbose']);
    });

    it('should default codexArgs to app-server', () => {
      const bridge = new CodexBridge();
      expect(bridge.codexArgs).toEqual(['app-server']);
    });

    it('should initialize internal state', () => {
      const bridge = new CodexBridge();
      expect(bridge._process).toBeNull();
      expect(bridge._threadId).toBeNull();
      expect(bridge._ready).toBe(false);
      expect(bridge._closing).toBe(false);
      expect(bridge._accumulatedText).toBe('');
      expect(bridge._inMessage).toBe(false);
      expect(bridge._firstMessage).toBe(true);
    });

    it('should set _firstMessage to false when resumeThreadId is provided', () => {
      const bridge = new CodexBridge({ resumeThreadId: 'thread-xyz' });
      expect(bridge._firstMessage).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isReady / isBusy
  // -------------------------------------------------------------------------
  describe('isReady', () => {
    it('should return false before start', () => {
      const bridge = new CodexBridge();
      expect(bridge.isReady()).toBe(false);
    });

    it('should return true after successful start', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();
      expect(bridge.isReady()).toBe(true);
    });

    it('should return false when closing', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();
      bridge._closing = true;
      expect(bridge.isReady()).toBe(false);
    });

    it('should return false when process is null', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();
      bridge._process = null;
      expect(bridge.isReady()).toBe(false);
    });
  });

  describe('isBusy', () => {
    it('should return false when not processing a message', () => {
      const bridge = new CodexBridge();
      expect(bridge.isBusy()).toBe(false);
    });

    it('should return true when processing a message', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      // sendMessage will set _inMessage = true; turn/start response sets turnId
      bridge.sendMessage('hello');
      await tick();

      expect(bridge.isBusy()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // start() — new session
  // -------------------------------------------------------------------------
  describe('start() — new session', () => {
    it('should spawn codex with app-server args', async () => {
      const { mockDeps, mockSpawn, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        cwd: '/my/repo',
        _deps: mockDeps,
      });
      await bridge.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining(['app-server']),
        expect.objectContaining({
          cwd: '/my/repo',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );
    });

    it('should pass configured model through thread params, not app-server CLI args', async () => {
      const { mockDeps, mockSpawn, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        model: 'o4-mini',
        _deps: mockDeps,
      });
      await bridge.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.not.arrayContaining(['--model', 'o4-mini']),
        expect.any(Object)
      );

      rl.close();
      const threadStart = messages.find((m) => m.method === 'thread/start');
      expect(threadStart.params.model).toBe('o4-mini');
    });

    it('should not include --model argument when model is not set', async () => {
      const { mockDeps, mockSpawn, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        _deps: mockDeps,
      });
      await bridge.start();

      // Should have default args but no --model
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[1]).toContain('app-server');
      expect(spawnCall[1]).not.toContain('--model');
    });

    it('should not include --model in shell command when useShell and model are set', async () => {
      const { mockDeps, mockSpawn, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        model: 'o4-mini',
        codexCommand: 'devx codex',
        codexArgs: ['app-server'],
        useShell: true,
        _deps: mockDeps,
      });
      await bridge.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'devx codex app-server',
        [],
        expect.objectContaining({ shell: true })
      );
    });

    it('should quote Codex config args in shell mode', async () => {
      const { mockDeps, mockSpawn, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        codexCommand: 'devx codex',
        codexArgs: [
          'app-server',
          '-c', 'allow_login_shell=false',
          '-c', 'shell_environment_policy.include_only=["PATH","HOME","USER"]',
        ],
        useShell: true,
        _deps: mockDeps,
      });
      await bridge.start();

      expect(mockSpawn).toHaveBeenCalledWith(
        'devx codex app-server -c allow_login_shell=false -c \'shell_environment_policy.include_only=["PATH","HOME","USER"]\'',
        [],
        expect.objectContaining({ shell: true })
      );
    });

    it('should include env vars in spawn options', async () => {
      const { mockDeps, mockSpawn, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        env: { MY_VAR: 'yes' },
        _deps: mockDeps,
      });
      await bridge.start();

      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env.MY_VAR).toBe('yes');
    });

    it('should send initialize request with client info', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      rl.close();
      const initReq = messages.find((m) => m.method === 'initialize');
      expect(initReq).toBeDefined();
      expect(initReq.params.clientInfo.name).toBe('pair-review');
      expect(initReq.params.clientInfo.version).toBeDefined();
      expect(initReq.id).toBeDefined();
    });

    it('should send initialized notification after initialize response', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      rl.close();
      const initializedNotif = messages.find((m) => m.method === 'initialized');
      expect(initializedNotif).toBeDefined();
      expect(initializedNotif.id).toBeUndefined();
    });

    it('should send thread/start request', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      rl.close();
      const threadStart = messages.find((m) => m.method === 'thread/start');
      expect(threadStart).toBeDefined();
      expect(threadStart.id).toBeDefined();
      expect(threadStart.params).toEqual(expect.objectContaining({
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      }));
      expect(threadStart.params).not.toHaveProperty('model');
    });

    it('should emit session event with threadId', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      await bridge.start();

      expect(sessionHandler).toHaveBeenCalledTimes(1);
      expect(sessionHandler).toHaveBeenCalledWith({ threadId: 'test-thread-123' });
    });

    it('should emit ready event', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      const readyHandler = vi.fn();
      bridge.on('ready', readyHandler);

      await bridge.start();

      expect(readyHandler).toHaveBeenCalledTimes(1);
    });

    it('should store the threadId', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      expect(bridge._threadId).toBe('test-thread-123');
    });

    it('should throw if already started', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      await expect(bridge.start()).rejects.toThrow(/already started/);
    });
  });

  // -------------------------------------------------------------------------
  // start() — resume session
  // -------------------------------------------------------------------------
  describe('start() — resume session', () => {
    it('should send thread/resume instead of thread/start', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc, { threadId: 'existing-thread-456' });

      const bridge = new CodexBridge({
        resumeThreadId: 'existing-thread-456',
        _deps: mockDeps,
      });
      await bridge.start();

      rl.close();
      const threadResume = messages.find((m) => m.method === 'thread/resume');
      expect(threadResume).toBeDefined();
      expect(threadResume.params.threadId).toBe('existing-thread-456');
      expect(threadResume.params).toEqual(expect.objectContaining({
        cwd: process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      }));
      expect(threadResume.params).not.toHaveProperty('model');

      const threadStart = messages.find((m) => m.method === 'thread/start');
      expect(threadStart).toBeUndefined();
    });

    it('should emit session with same threadId', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc, { threadId: 'existing-thread-456' });

      const bridge = new CodexBridge({
        resumeThreadId: 'existing-thread-456',
        _deps: mockDeps,
      });
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      await bridge.start();

      expect(sessionHandler).toHaveBeenCalledWith({ threadId: 'existing-thread-456' });
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage()
  // -------------------------------------------------------------------------
  describe('sendMessage()', () => {
    it('should throw if not ready', async () => {
      const bridge = new CodexBridge();
      await expect(bridge.sendMessage('hello')).rejects.toThrow(/not ready/);
    });

    it('should prepend system prompt on first message only', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({
        systemPrompt: 'You are a reviewer',
        _deps: mockDeps,
      });
      await bridge.start();

      bridge.sendMessage('First message');
      await tick();

      const firstTurn = messages.find(
        (m) => m.method === 'turn/start' && m.params?.input?.[0]?.text?.includes('First message')
      );
      expect(firstTurn).toBeDefined();
      expect(firstTurn.params.input).toEqual([{ type: 'text', text: expect.stringContaining('You are a reviewer') }]);
      expect(firstTurn.params.input[0].text).toContain('First message');

      // Second message should NOT include system prompt
      bridge.sendMessage('Second message');
      await tick();

      rl.close();
      const secondTurn = messages.find(
        (m) => m.method === 'turn/start' && m.params?.input?.[0]?.text?.includes('Second message')
      );
      expect(secondTurn).toBeDefined();
      expect(secondTurn.params.input).toEqual([{ type: 'text', text: 'Second message' }]);
    });

    it('should not prepend system prompt when none is set', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('Hello');
      await tick();

      rl.close();
      const turnReq = messages.find(
        (m) => m.method === 'turn/start' && m.params?.input?.[0]?.text?.includes('Hello')
      );
      expect(turnReq).toBeDefined();
      expect(turnReq.params.input).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('should send turn/start with threadId, input, and approvalPolicy', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('Review this code');
      await tick();

      rl.close();
      const turnReq = messages.find((m) => m.method === 'turn/start');
      expect(turnReq).toBeDefined();
      expect(turnReq.params.threadId).toBe('test-thread-123');
      expect(turnReq.params.input).toEqual([{ type: 'text', text: 'Review this code' }]);
      expect(turnReq.params.approvalPolicy).toBe('never');
      expect(turnReq.params.cwd).toBe(process.cwd());
      expect(turnReq.params).not.toHaveProperty('model');
      expect(turnReq.params.sandboxPolicy).toEqual({
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      });
    });

    it('should send CLI-style sandbox to thread params and policy object to turn params', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ sandbox: 'read-only', _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('Review this code');
      await tick();

      rl.close();
      const threadReq = messages.find((m) => m.method === 'thread/start');
      const turnReq = messages.find((m) => m.method === 'turn/start');
      expect(threadReq.params.sandbox).toBe('read-only');
      expect(turnReq.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true });
    });

    it('should pass configured model through turn params', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ model: 'o4-mini', _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('Review this code');
      await tick();

      rl.close();
      const turnReq = messages.find((m) => m.method === 'turn/start');
      expect(turnReq.params.model).toBe('o4-mini');
    });

    it('should reset accumulated text on new message', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      bridge._accumulatedText = 'leftover from previous turn';
      bridge.sendMessage('new question');
      await tick();

      expect(bridge._accumulatedText).toBe('');
    });

    it('should set _inMessage to true', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('hello');
      await tick();

      expect(bridge._inMessage).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Notification handling
  // -------------------------------------------------------------------------
  describe('notification handling', () => {
    async function startedBridge() {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();
      return { bridge, fakeProc };
    }

    it('should emit delta on item/agentMessage/delta', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      sendNotification(fakeProc, 'item/agentMessage/delta', {
        delta: 'Hello world',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({ text: 'Hello world' });
    });

    it('should accumulate text from multiple deltas', async () => {
      const { bridge, fakeProc } = await startedBridge();

      sendNotification(fakeProc, 'item/agentMessage/delta', { delta: 'Hello ' });
      sendNotification(fakeProc, 'item/agentMessage/delta', { delta: 'world' });
      await tick();

      expect(bridge._accumulatedText).toBe('Hello world');
    });

    it('should preserve sentence spacing across adjacent deltas', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      sendNotification(fakeProc, 'item/agentMessage/delta', { delta: 'bad.' });
      sendNotification(fakeProc, 'item/agentMessage/delta', { delta: 'First' });
      await tick();

      expect(handler).toHaveBeenNthCalledWith(1, { text: 'bad.' });
      expect(handler).toHaveBeenNthCalledWith(2, { text: ' First' });
      expect(bridge._accumulatedText).toBe('bad. First');
    });

    it('should emit complete on turn/completed with status=completed', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('complete', handler);
      bridge._inMessage = true;
      bridge._accumulatedText = 'Full response text';

      sendNotification(fakeProc, 'turn/completed', { status: 'completed' });
      await tick();

      expect(handler).toHaveBeenCalledWith({ fullText: 'Full response text' });
      expect(bridge._inMessage).toBe(false);
      expect(bridge._accumulatedText).toBe('');
    });

    it('should emit error on turn/completed with status=failed', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('error', handler);
      bridge._inMessage = true;

      sendNotification(fakeProc, 'turn/completed', {
        status: 'failed',
        error: { message: 'Something went wrong' },
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        error: expect.any(Error),
      });
      expect(handler.mock.calls[0][0].error.message).toContain('Something went wrong');
      expect(bridge._inMessage).toBe(false);
    });

    it('should emit status on turn/started', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('status', handler);

      sendNotification(fakeProc, 'turn/started', { turnId: 'turn-001' });
      await tick();

      expect(handler).toHaveBeenCalledWith({ status: 'working' });
    });

    it('should capture nested turn id from turn/started notification', async () => {
      const { bridge, fakeProc } = await startedBridge();

      sendNotification(fakeProc, 'turn/started', {
        threadId: 'test-thread-123',
        turn: { id: 'turn-nested-001', items: [], status: 'running' },
      });
      await tick();

      expect(bridge._turnId).toBe('turn-nested-001');
    });

    it('should not revive turn id from terminal turn/statusChanged after completion', async () => {
      const { bridge, fakeProc } = await startedBridge();

      bridge._turnId = 'turn-active';
      bridge._inMessage = true;
      sendNotification(fakeProc, 'turn/completed', { status: 'completed' });
      await tick();

      sendNotification(fakeProc, 'turn/statusChanged', {
        turn: { id: 'turn-late', status: 'completed' },
      });
      await tick();

      expect(bridge._turnId).toBeNull();
      expect(bridge._inMessage).toBe(false);
    });

    it('should capture turn id from active turn/statusChanged notification', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('status', handler);

      sendNotification(fakeProc, 'turn/statusChanged', {
        turn: { id: 'turn-active-status', status: 'inProgress' },
      });
      await tick();

      expect(bridge._turnId).toBe('turn-active-status');
      expect(handler).toHaveBeenCalledWith({ status: 'working' });
    });

    it('should capture nested turn id from turn/start response', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc, {
        turnStartResult: {
          turn: { id: 'turn-response-nested', items: [], status: 'running' },
        },
      });

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.sendMessage('some task');
      await tick();

      expect(bridge._turnId).toBe('turn-response-nested');
    });

    it('should emit tool_use with start on item/started (command type)', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      sendNotification(fakeProc, 'item/started', {
        type: 'command',
        id: 'item-1',
        command: 'cat src/main.js',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'item-1',
        toolName: 'bash',
        args: { command: 'cat src/main.js' },
        status: 'start',
      });
    });

    it('should emit tool_use with end on item/completed (command type)', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      sendNotification(fakeProc, 'item/completed', {
        type: 'command',
        id: 'item-1',
        command: 'cat src/main.js',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'item-1',
        toolName: 'bash',
        args: { command: 'cat src/main.js' },
        status: 'end',
      });
    });

    it('should emit tool_use with start on item/started (tool_call type)', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      sendNotification(fakeProc, 'item/started', {
        type: 'tool_call',
        id: 'tc-1',
        name: 'read_file',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        status: 'start',
      });
    });

    it('should emit tool_use with end on item/completed (tool_call type)', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      sendNotification(fakeProc, 'item/completed', {
        type: 'tool_call',
        id: 'tc-1',
        name: 'read_file',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'tc-1',
        toolName: 'read_file',
        status: 'end',
      });
    });

    it('should emit tool_use with start on item/started (function_call type)', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      sendNotification(fakeProc, 'item/started', {
        type: 'function_call',
        id: 'fc-1',
        name: 'search_code',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'fc-1',
        toolName: 'search_code',
        status: 'start',
      });
    });

    it('should emit tool_use with end on item/completed (function_call type)', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const handler = vi.fn();
      bridge.on('tool_use', handler);

      sendNotification(fakeProc, 'item/completed', {
        type: 'function_call',
        id: 'fc-1',
        name: 'search_code',
      });
      await tick();

      expect(handler).toHaveBeenCalledWith({
        toolCallId: 'fc-1',
        toolName: 'search_code',
        status: 'end',
      });
    });

    it('should not throw on unknown notification methods', async () => {
      const { bridge, fakeProc } = await startedBridge();
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      sendNotification(fakeProc, 'unknown/event', { data: 'whatever' });
      await tick();

      expect(errorHandler).not.toHaveBeenCalled();
      expect(bridge.isReady()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Approval handling (server requests)
  // -------------------------------------------------------------------------
  describe('approval handling', () => {
    it('should auto-respond to requestApproval with accept', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      // Server sends a requestApproval request
      sendServerRequest(fakeProc, 'requestApproval', {
        toolCallId: 'tc-1',
        command: 'rm -rf /',
      }, 'server-req-1');
      await tick();

      rl.close();
      const approvalResponse = messages.find(
        (m) => m.id === 'server-req-1' && m.result
      );
      expect(approvalResponse).toBeDefined();
      expect(approvalResponse.result.decision).toBe('accept');
    });

    it('should auto-respond to commandExecution approval with accept', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      sendServerRequest(fakeProc, 'item/commandExecution/requestApproval', {
        command: 'curl -s http://localhost:7247/api/reviews/1/comments',
      }, 'server-req-command');
      await tick();

      rl.close();
      const response = messages.find((m) => m.id === 'server-req-command' && m.result);
      expect(response).toBeDefined();
      expect(response.result.decision).toBe('accept');
    });

    it('should auto-respond to legacy execCommandApproval with approved', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      sendServerRequest(fakeProc, 'execCommandApproval', {
        command: 'curl -s http://localhost:7247/api/reviews/1/comments',
      }, 'server-req-exec');
      await tick();

      rl.close();
      const response = messages.find((m) => m.id === 'server-req-exec' && m.result);
      expect(response).toBeDefined();
      expect(response.result.decision).toBe('approved');
    });

    it('should grant requested network permissions', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      sendServerRequest(fakeProc, 'item/permissions/requestApproval', {
        permissions: { network: { enabled: true }, fileSystem: null },
      }, 'server-req-permissions');
      await tick();

      rl.close();
      const response = messages.find((m) => m.id === 'server-req-permissions' && m.result);
      expect(response).toBeDefined();
      expect(response.result).toEqual({
        permissions: { network: { enabled: true } },
        scope: 'session',
        strictAutoReview: false,
      });
    });

    it('should grant network permissions when request omits network payload', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      sendServerRequest(fakeProc, 'item/permissions/requestApproval', {
        permissions: { fileSystem: null },
      }, 'server-req-permissions-no-network');
      await tick();

      rl.close();
      const response = messages.find((m) => m.id === 'server-req-permissions-no-network' && m.result);
      expect(response).toBeDefined();
      expect(response.result).toEqual({
        permissions: { network: { enabled: true } },
        scope: 'session',
        strictAutoReview: false,
      });
    });

    it('should decline file change approval requests', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      sendServerRequest(fakeProc, 'item/fileChange/requestApproval', {
        reason: 'extra write access',
      }, 'server-req-file');
      await tick();

      rl.close();
      const response = messages.find((m) => m.id === 'server-req-file' && m.result);
      expect(response).toBeDefined();
      expect(response.result.decision).toBe('decline');
    });

    it('should deny applyPatchApproval requests', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      sendServerRequest(fakeProc, 'applyPatchApproval', {
        files: ['src/main.js'],
      }, 'server-req-patch');
      await tick();

      rl.close();
      const response = messages.find((m) => m.id === 'server-req-patch' && m.result);
      expect(response).toBeDefined();
      expect(response.result).toEqual({ decision: 'denied' });
    });

    it('should respond with JSON-RPC error for unknown server requests', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const stdinRl = createInterface({ input: fakeProc.stdin });
      const stdinMessages = [];
      stdinRl.on('line', (line) => {
        try { stdinMessages.push(JSON.parse(line)); } catch { /* ignore */ }
      });

      sendServerRequest(fakeProc, 'unknown/method', { data: 'test' }, 'server-req-2');
      await tick();

      stdinRl.close();
      const errorResponse = stdinMessages.find(
        (m) => m.id === 'server-req-2' && m.error
      );
      expect(errorResponse).toBeDefined();
      expect(errorResponse.error.code).toBeDefined();
      expect(errorResponse.error.message).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // abort()
  // -------------------------------------------------------------------------
  describe('abort()', () => {
    it('should send turn/interrupt with threadId and turnId when turn active', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      // Simulate an active turn
      bridge.sendMessage('some task');
      await tick();

      bridge.abort();
      await tick();

      rl.close();
      const interruptReq = messages.find((m) => m.method === 'turn/interrupt');
      expect(interruptReq).toBeDefined();
      expect(interruptReq.params.threadId).toBe('test-thread-123');
      expect(interruptReq.params.turnId).toBe('turn-001');
    });

    it('should be a no-op when no active turn', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      const { messages, rl } = collectStdinMessages(fakeProc);
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      // No sendMessage called, so no active turn
      bridge.abort();
      await tick();

      rl.close();
      const interruptReq = messages.find((m) => m.method === 'turn/interrupt');
      expect(interruptReq).toBeUndefined();
    });

    it('should not throw when not ready', () => {
      const bridge = new CodexBridge();
      expect(() => bridge.abort()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------
  describe('close()', () => {
    it('should do nothing if process is null', async () => {
      const bridge = new CodexBridge();
      await bridge.close(); // Should resolve without error
    });

    it('should set _closing to true', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const closePromise = bridge.close();
      expect(bridge._closing).toBe(true);

      fakeProc.emit('close', 0, null);
      await closePromise;
    });

    it('should reject pending requests', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      // Send a request that handshake won't auto-respond to
      const pendingPromise = bridge._sendRequest('custom/method', {});

      const closePromise = bridge.close();
      fakeProc.emit('close', 0, null);
      await closePromise;

      await expect(pendingPromise).rejects.toThrow(/closing/);
    });

    it('should send SIGTERM to the process', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const closePromise = bridge.close();
      await tick();

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

      fakeProc.emit('close', 0, 'SIGTERM');
      await closePromise;
    });

    it('should force kill with SIGKILL after timeout', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      vi.useFakeTimers();
      try {
        const closePromise = bridge.close();

        await vi.advanceTimersByTimeAsync(0);

        // Process does not exit, advance past timeout
        await vi.advanceTimersByTimeAsync(3000);

        expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

        fakeProc.emit('close', 0, 'SIGKILL');
        await closePromise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should resolve when process emits close', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const closePromise = bridge.close();
      fakeProc.emit('close', 0, null);
      // close() resolves without error
      await expect(closePromise).resolves.toBeUndefined();
    });

    it('should remove all listeners after close', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      bridge.on('delta', vi.fn());
      bridge.on('complete', vi.fn());

      const closePromise = bridge.close();
      fakeProc.emit('close', 0, null);
      await closePromise;

      expect(bridge.listenerCount('delta')).toBe(0);
      expect(bridge.listenerCount('complete')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // _sendRequest timeout
  // -------------------------------------------------------------------------
  describe('_sendRequest timeout', () => {
    it('should timeout pending requests after 30s', async () => {
      vi.useFakeTimers();
      try {
        const { mockDeps, fakeProc } = createMockDeps();
        handshakeRl = setupHandshake(fakeProc);

        const bridge = new CodexBridge({ _deps: mockDeps });
        await bridge.start();

        // Send a request that won't get a response
        const pendingPromise = bridge._sendRequest('custom/no-reply', {});

        // Advance past timeout
        vi.advanceTimersByTime(30000);

        await expect(pendingPromise).rejects.toThrow(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('should reject start on spawn error', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      // Don't set up handshake so initialize hangs

      const bridge = new CodexBridge({ _deps: mockDeps });
      const startPromise = bridge.start();

      fakeProc.emit('error', new Error('ENOENT'));

      await expect(startPromise).rejects.toThrow();
    });

    it('should reject start on unexpected process exit before ready', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      // Don't set up handshake so start hangs

      const bridge = new CodexBridge({ _deps: mockDeps });
      bridge.on('error', () => {}); // prevent unhandled error
      const startPromise = bridge.start();

      fakeProc.emit('close', 1, null);

      await expect(startPromise).rejects.toThrow();
    });

    it('should emit error on process error after ready', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      fakeProc.emit('error', new Error('SIGPIPE'));

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.any(Error),
      });
    });

    it('should emit error and close on unexpected exit after ready', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      const closeHandler = vi.fn();
      bridge.on('error', errorHandler);
      bridge.on('close', closeHandler);

      fakeProc.emit('close', 1, null);

      expect(errorHandler).toHaveBeenCalledWith({
        error: expect.objectContaining({
          message: expect.stringContaining('exited'),
        }),
      });
      expect(closeHandler).toHaveBeenCalled();
      expect(bridge.isReady()).toBe(false);
    });

    it('should not emit error on expected close (closing flag)', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      bridge._closing = true;
      fakeProc.emit('close', 0, 'SIGTERM');

      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON on stdout gracefully', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      handshakeRl = setupHandshake(fakeProc);

      const bridge = new CodexBridge({ _deps: mockDeps });
      await bridge.start();

      // Write garbage to stdout — should not crash
      fakeProc.stdout.write('this is not json\n');
      await tick();

      // Bridge should still be operational
      expect(bridge.isReady()).toBe(true);
    });

    it('should reject pending request when response is an error', async () => {
      const { mockDeps, fakeProc } = createMockDeps();
      // Custom handshake: respond to initialize normally, but error on thread/start
      const rl = createInterface({ input: fakeProc.stdin });
      let initDone = false;
      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id == null || !msg.method) return;

        if (msg.method === 'initialize') {
          sendResponse(fakeProc, msg.id, {
            serverInfo: { name: 'codex', version: '1.0.0' },
            capabilities: {},
          });
          initDone = true;
        } else if (msg.method === 'thread/start' && initDone) {
          sendErrorResponse(fakeProc, msg.id, -32000, 'Thread creation failed');
        }
      });
      handshakeRl = rl;

      const bridge = new CodexBridge({ _deps: mockDeps });
      bridge.on('error', () => {}); // prevent unhandled

      await expect(bridge.start()).rejects.toThrow(/Thread creation failed/);
    });
  });
});
