// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for AcpProvider and createAcpProviderClass
 */

const { EventEmitter } = require('events');

// Mock logger before importing the module under test
vi.mock('../../src/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
  streamDebug: vi.fn(),
  section: vi.fn(),
  isStreamDebugEnabled: () => false,
  setStreamDebugEnabled: vi.fn(),
}));

// Import after mocks are set up
const { AcpProvider, createAcpProviderClass } = require('../../src/ai/acp-provider');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockProcess(exitCode = 0, stdout = 'v1.0.0', error = null) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn(() => {
    proc.killed = true;
    // Simulate 'close' after kill for cleanup promise resolution
    setTimeout(() => proc.emit('close', null), 0);
  });
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 12345;
  // Schedule events after spawn returns
  setTimeout(() => {
    if (error) { proc.emit('error', error); return; }
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  }, 0);
  return proc;
}

function createMockDeps(responseText = '{"level":1,"suggestions":[]}') {
  const mockProcess = new EventEmitter();
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();
  mockProcess.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  mockProcess.kill = vi.fn(() => {
    mockProcess.killed = true;
    setTimeout(() => mockProcess.emit('close', null), 0);
  });
  mockProcess.killed = false;
  mockProcess.exitCode = null;
  mockProcess.pid = 99999;

  const mockSpawn = vi.fn().mockReturnValue(mockProcess);

  // Track handler references set during ClientSideConnection construction
  let sessionUpdateHandler = null;
  let permissionHandler = null;

  const mockConnection = {
    initialize: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-123' }),
    unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockImplementation(async () => {
      // Simulate agent_message_chunk during prompt execution
      if (sessionUpdateHandler) {
        sessionUpdateHandler({
          sessionId: 'test-session-123',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: responseText },
          },
        });
      }
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };

  // Must use a real function (not arrow) so it can be called with `new`
  function MockClientSideConnection(handlerFactory) {
    const handler = handlerFactory('mock-agent');
    sessionUpdateHandler = handler.sessionUpdate;
    permissionHandler = handler.requestPermission;
    Object.assign(this, mockConnection);
  }

  const mockAcp = {
    ndJsonStream: vi.fn().mockReturnValue('mock-stream'),
    ClientSideConnection: MockClientSideConnection,
    PROTOCOL_VERSION: '2025-01-01',
  };

  return {
    _deps: {
      spawn: mockSpawn,
      acp: mockAcp,
      Writable: { toWeb: vi.fn().mockReturnValue('mock-writable') },
      Readable: { toWeb: vi.fn().mockReturnValue('mock-readable') },
    },
    mockConnection,
    mockSpawn,
    mockProcess,
    mockAcp,
    get permissionHandler() { return permissionHandler; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean env vars that might interfere
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PAIR_REVIEW_') && key.endsWith('_CMD')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // -------------------------------------------------------------------------
  // createAcpProviderClass (factory)
  // -------------------------------------------------------------------------

  describe('createAcpProviderClass', () => {
    it('should return a class with correct static getProviderId()', () => {
      const Cls = createAcpProviderClass('my-agent', { command: 'my-agent' });
      expect(Cls.getProviderId()).toBe('my-agent');
    });

    it('should return config.name from getProviderName()', () => {
      const Cls = createAcpProviderClass('x', { name: 'My Custom Agent', command: 'x' });
      expect(Cls.getProviderName()).toBe('My Custom Agent');
    });

    it('should prettify provider ID when name not provided', () => {
      const Cls = createAcpProviderClass('my-cool-agent', { command: 'mca' });
      expect(Cls.getProviderName()).toBe('My Cool Agent');
    });

    it('should return config models with inferred defaults', () => {
      const Cls = createAcpProviderClass('test', {
        command: 'test',
        models: [
          { id: 'model-a', tier: 'fast' },
          { id: 'model-b', tier: 'balanced', default: true },
        ],
      });
      const models = Cls.getModels();
      expect(models).toHaveLength(2);
      expect(models[0].badge).toBe('Fastest'); // inferred from tier
      expect(models[0].name).toBe('Model A'); // prettified
      expect(models[1].badge).toBe('Recommended');
    });

    it('should return a single "default" model when no models configured', () => {
      const Cls = createAcpProviderClass('bare', { command: 'bare' });
      const models = Cls.getModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('default');
      expect(models[0].tier).toBe('balanced');
      expect(models[0].default).toBe(true);
    });

    it('should return a single "default" model when models is empty array', () => {
      const Cls = createAcpProviderClass('bare', { command: 'bare', models: [] });
      const models = Cls.getModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('default');
    });

    it('should resolve getDefaultModel() from explicit default:true', () => {
      const Cls = createAcpProviderClass('test', {
        command: 'test',
        models: [
          { id: 'fast-one', tier: 'fast' },
          { id: 'the-default', tier: 'thorough', default: true },
        ],
      });
      expect(Cls.getDefaultModel()).toBe('the-default');
    });

    it('should resolve getDefaultModel() to first balanced model when no explicit default', () => {
      const Cls = createAcpProviderClass('test', {
        command: 'test',
        models: [
          { id: 'fast-one', tier: 'fast' },
          { id: 'balanced-one', tier: 'balanced' },
        ],
      });
      expect(Cls.getDefaultModel()).toBe('balanced-one');
    });

    it('should resolve getDefaultModel() to "default" when no models configured', () => {
      const Cls = createAcpProviderClass('bare', { command: 'bare' });
      expect(Cls.getDefaultModel()).toBe('default');
    });

    it('should return config installInstructions when provided', () => {
      const Cls = createAcpProviderClass('test', {
        command: 'test',
        installInstructions: 'Run: brew install test',
      });
      expect(Cls.getInstallInstructions()).toBe('Run: brew install test');
    });

    it('should generate fallback installInstructions', () => {
      const Cls = createAcpProviderClass('test', { command: 'test', name: 'TestAgent' });
      expect(Cls.getInstallInstructions()).toContain('TestAgent');
      expect(Cls.getInstallInstructions()).toContain('--acp --stdio');
    });

    it('should produce a class that extends AcpProvider', () => {
      const Cls = createAcpProviderClass('ext-test', { command: 'ext' });
      const instance = new Cls();
      expect(instance).toBeInstanceOf(AcpProvider);
    });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    let TestProvider;

    beforeEach(() => {
      TestProvider = createAcpProviderClass('test-provider', { command: 'test-cmd' });
    });

    it('should set default args to ["--acp", "--stdio"]', () => {
      const instance = new TestProvider('default', { command: 'test-cmd' });
      expect(instance.args).toEqual(['--acp', '--stdio']);
    });

    it('should use custom args when provided', () => {
      const instance = new TestProvider('default', {
        command: 'test-cmd',
        args: ['--custom', '--flag'],
      });
      expect(instance.args).toEqual(['--custom', '--flag']);
    });

    it('should set useShell=true when command contains spaces', () => {
      const instance = new TestProvider('default', { command: 'devx my-agent' });
      expect(instance.useShell).toBe(true);
    });

    it('should set useShell=false for single-word commands', () => {
      const instance = new TestProvider('default', { command: 'myagent' });
      expect(instance.useShell).toBe(false);
    });

    it('should respect environment variable override for command', () => {
      process.env.PAIR_REVIEW_TEST_PROVIDER_CMD = '/custom/path/to/agent';
      const instance = new TestProvider('default', { command: 'test-cmd' });
      expect(instance.command).toBe('/custom/path/to/agent');
    });

    it('should store extraEnv from config', () => {
      const instance = new TestProvider('default', {
        command: 'test-cmd',
        env: { MY_VAR: 'hello' },
      });
      expect(instance.extraEnv).toEqual({ MY_VAR: 'hello' });
    });

    it('should accept _deps for dependency injection', () => {
      const customSpawn = vi.fn();
      const instance = new TestProvider('default', {
        command: 'test-cmd',
        _deps: { spawn: customSpawn },
      });
      expect(instance._deps.spawn).toBe(customSpawn);
    });

    it('should default model to "default"', () => {
      const instance = new TestProvider();
      expect(instance.model).toBe('default');
    });
  });

  // -------------------------------------------------------------------------
  // testAvailability()
  // -------------------------------------------------------------------------

  describe('testAvailability()', () => {
    it('should return true when --version exits with code 0', async () => {
      const proc = createMockProcess(0, 'v1.2.3');
      const mockSpawn = vi.fn().mockReturnValue(proc);
      const TestProvider = createAcpProviderClass('avail-test', { command: 'myagent' });
      const instance = new TestProvider('default', {
        command: 'myagent',
        _deps: { spawn: mockSpawn },
      });

      const result = await instance.testAvailability();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('myagent', ['--version'], expect.any(Object));
    });

    it('should return false when command exits with non-zero code', async () => {
      const proc = createMockProcess(1, '');
      const mockSpawn = vi.fn().mockReturnValue(proc);
      const TestProvider = createAcpProviderClass('avail-test', { command: 'myagent' });
      const instance = new TestProvider('default', {
        command: 'myagent',
        _deps: { spawn: mockSpawn },
      });

      const result = await instance.testAvailability();
      expect(result).toBe(false);
    });

    it('should return false when command not found (ENOENT)', async () => {
      const proc = createMockProcess(0, '', new Error('ENOENT'));
      const mockSpawn = vi.fn().mockReturnValue(proc);
      const TestProvider = createAcpProviderClass('avail-test', { command: 'nonexistent' });
      const instance = new TestProvider('default', {
        command: 'nonexistent',
        _deps: { spawn: mockSpawn },
      });

      const result = await instance.testAvailability();
      expect(result).toBe(false);
    });

    it('should use shell mode for multi-word commands', async () => {
      const proc = createMockProcess(0, 'v2.0.0');
      const mockSpawn = vi.fn().mockReturnValue(proc);
      const TestProvider = createAcpProviderClass('avail-test', { command: 'devx myagent' });
      const instance = new TestProvider('default', {
        command: 'devx myagent',
        _deps: { spawn: mockSpawn },
      });

      const result = await instance.testAvailability();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        'devx myagent --version',
        [],
        expect.objectContaining({ shell: true })
      );
    });
  });

  // -------------------------------------------------------------------------
  // execute() — Happy path
  // -------------------------------------------------------------------------

  describe('execute()', () => {
    it('should spawn process with correct command and args', async () => {
      const { _deps, mockSpawn } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      await instance.execute('review this code', { cwd: '/test/dir' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'myagent',
        ['--acp', '--stdio'],
        expect.objectContaining({
          cwd: '/test/dir',
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        })
      );
    });

    it('should use shell mode for multi-word commands', async () => {
      const { _deps, mockSpawn } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', { command: 'devx myagent' });
      const instance = new TestProvider('default', { command: 'devx myagent', _deps });

      await instance.execute('review this code');

      expect(mockSpawn).toHaveBeenCalledWith(
        'devx myagent --acp --stdio',
        [],
        expect.objectContaining({ shell: true })
      );
    });

    it('should perform ACP handshake with correct params', async () => {
      const { _deps, mockConnection } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      await instance.execute('prompt');

      expect(mockConnection.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          protocolVersion: '2025-01-01',
          clientInfo: expect.objectContaining({ name: 'pair-review' }),
        })
      );
    });

    it('should create new session with cwd', async () => {
      const { _deps, mockConnection } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      await instance.execute('prompt', { cwd: '/work/dir' });

      expect(mockConnection.newSession).toHaveBeenCalledWith({ cwd: '/work/dir' });
    });

    it('should NOT call unstable_setSessionModel when model is "default"', async () => {
      const { _deps, mockConnection } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      await instance.execute('prompt');

      expect(mockConnection.unstable_setSessionModel).not.toHaveBeenCalled();
    });

    it('should call unstable_setSessionModel when model is NOT "default"', async () => {
      const { _deps, mockConnection } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', {
        command: 'myagent',
        models: [{ id: 'gpt-5', tier: 'balanced', default: true }],
      });
      const instance = new TestProvider('gpt-5', { command: 'myagent', _deps });

      await instance.execute('prompt');

      expect(mockConnection.unstable_setSessionModel).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        modelId: 'gpt-5',
      });
    });

    it('should send prompt via connection.prompt()', async () => {
      const { _deps, mockConnection } = createMockDeps();
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      await instance.execute('review this code');

      expect(mockConnection.prompt).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        prompt: [{ type: 'text', text: 'review this code' }],
      });
    });

    it('should parse JSON from accumulated text', async () => {
      const { _deps } = createMockDeps('{"level":1,"suggestions":[{"text":"good"}]}');
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      const result = await instance.execute('prompt');

      expect(result).toEqual({ level: 1, suggestions: [{ text: 'good' }] });
    });

    it('should return { raw, parsed: false } when extraction fails', async () => {
      const nonJsonText = 'This is not JSON at all, just plain text with no structure.';
      const { _deps } = createMockDeps(nonJsonText);
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });
      // getExtractionConfig returns null, so extractJSONWithLLM will fail
      const result = await instance.execute('prompt');

      expect(result).toEqual({ raw: nonJsonText, parsed: false });
    });

    it('should call onStreamEvent for agent_message_chunk', async () => {
      const { _deps } = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });
      const onStreamEvent = vi.fn();

      await instance.execute('prompt', { onStreamEvent });

      expect(onStreamEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'assistant_text',
          text: expect.any(String),
          timestamp: expect.any(Number),
        })
      );
    });

    it('should call onStreamEvent for tool_call updates', async () => {
      // Custom mock that emits a tool_call update
      const mockProcess = new EventEmitter();
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.stdin = { on: vi.fn() };
      mockProcess.kill = vi.fn(() => {
        mockProcess.killed = true;
        setTimeout(() => mockProcess.emit('close', null), 0);
      });
      mockProcess.killed = false;
      mockProcess.pid = 88888;

      let sessionUpdateHandler = null;
      const mockConnection = {
        initialize: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
        unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockImplementation(async () => {
          if (sessionUpdateHandler) {
            // Emit tool_call
            sessionUpdateHandler({
              sessionId: 'sess-1',
              update: { sessionUpdate: 'tool_call', title: 'Read file', kind: 'shell' },
            });
            // Then emit text with JSON
            sessionUpdateHandler({
              sessionId: 'sess-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '{"level":1}' },
              },
            });
          }
        }),
      };

      function MockCSC(handlerFactory) {
        const handler = handlerFactory('mock-agent');
        sessionUpdateHandler = handler.sessionUpdate;
        Object.assign(this, mockConnection);
      }

      const mockAcp = {
        ndJsonStream: vi.fn().mockReturnValue('mock-stream'),
        ClientSideConnection: MockCSC,
        PROTOCOL_VERSION: '2025-01-01',
      };

      const _deps = {
        spawn: vi.fn().mockReturnValue(mockProcess),
        acp: mockAcp,
        Writable: { toWeb: vi.fn().mockReturnValue('w') },
        Readable: { toWeb: vi.fn().mockReturnValue('r') },
      };

      const TestProvider = createAcpProviderClass('tool-test', { command: 'agent' });
      const instance = new TestProvider('default', { command: 'agent', _deps });
      const onStreamEvent = vi.fn();

      await instance.execute('prompt', { onStreamEvent });

      const toolEvents = onStreamEvent.mock.calls
        .map(c => c[0])
        .filter(e => e.type === 'tool_use');
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0].text).toContain('Read file');
    });

    it('should kill process in finally block even on success', async () => {
      const { _deps, mockProcess } = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      await instance.execute('prompt');

      // Process should have been killed in finally
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('should register process for cancellation tracking', async () => {
      const { _deps } = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });
      const registerProcess = vi.fn();

      await instance.execute('prompt', { analysisId: 'a-123', registerProcess });

      expect(registerProcess).toHaveBeenCalledWith('a-123', expect.objectContaining({ pid: 99999 }));
    });

    it('should include extraEnv in spawned process environment', async () => {
      const { _deps, mockSpawn } = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', {
        command: 'myagent',
        env: { CUSTOM_VAR: 'custom_value' },
        _deps,
      });

      await instance.execute('prompt');

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.CUSTOM_VAR).toBe('custom_value');
    });

    it('should handle timeout by rejecting with error', async () => {
      // Create a mock that never resolves prompt
      const mockProcess = new EventEmitter();
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      mockProcess.stdin = { on: vi.fn() };
      mockProcess.kill = vi.fn(() => {
        mockProcess.killed = true;
        setTimeout(() => mockProcess.emit('close', null), 0);
      });
      mockProcess.killed = false;
      mockProcess.pid = 77777;

      const mockConnection = {
        initialize: vi.fn().mockResolvedValue(undefined),
        newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-timeout' }),
        unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      };

      function MockCSCTimeout(handlerFactory) {
        handlerFactory('mock-agent');
        Object.assign(this, mockConnection);
      }

      const mockAcp = {
        ndJsonStream: vi.fn().mockReturnValue('mock-stream'),
        ClientSideConnection: MockCSCTimeout,
        PROTOCOL_VERSION: '2025-01-01',
      };

      const _deps = {
        spawn: vi.fn().mockReturnValue(mockProcess),
        acp: mockAcp,
        Writable: { toWeb: vi.fn().mockReturnValue('w') },
        Readable: { toWeb: vi.fn().mockReturnValue('r') },
      };

      const TestProvider = createAcpProviderClass('timeout-test', { command: 'slow-agent' });
      const instance = new TestProvider('default', { command: 'slow-agent', _deps });

      await expect(instance.execute('prompt', { timeout: 50 }))
        .rejects.toThrow(/timed out/);
    });

    it('should handle unstable_setSessionModel failure gracefully', async () => {
      const { _deps, mockConnection } = createMockDeps('{"level":1}');
      mockConnection.unstable_setSessionModel.mockRejectedValue(new Error('not supported'));

      const TestProvider = createAcpProviderClass('exec-test', {
        command: 'myagent',
        models: [{ id: 'custom-model', tier: 'balanced', default: true }],
      });
      const instance = new TestProvider('custom-model', { command: 'myagent', _deps });

      // Should not throw — warn and continue
      const result = await instance.execute('prompt');
      expect(result).toEqual({ level: 1 });
    });

    it('should not hang in killProcess when process has already exited naturally', async () => {
      const { _deps, mockProcess } = createMockDeps('{"level":1}');
      // Simulate a process that has already exited on its own before killProcess runs.
      // Set exitCode (non-null) and override kill to NOT emit 'close' — if killProcess
      // doesn't check exitCode, it will call kill() and wait for 'close' that never fires.
      mockProcess.exitCode = 0;
      mockProcess.kill = vi.fn(); // no-op, no 'close' event emitted

      const TestProvider = createAcpProviderClass('exec-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps });

      // Should resolve without hanging (killProcess sees exitCode !== null and returns)
      const result = await instance.execute('prompt');
      expect(result).toEqual({ level: 1 });
      // kill should NOT have been called since exitCode was already set
      expect(mockProcess.kill).not.toHaveBeenCalled();
    });

    it('should quote shell-sensitive args in shell mode to preserve argument boundaries', async () => {
      const { _deps, mockSpawn } = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('exec-test', { command: 'devx myagent' });
      const instance = new TestProvider('default', {
        command: 'devx myagent',
        args: ['--acp', '--config', '/path/with spaces/config.json', '--flag=value(1)'],
        _deps,
      });

      await instance.execute('prompt');

      // In shell mode, the first argument to spawn is the full command string.
      // Args with spaces and metacharacters should be single-quoted.
      const spawnCmd = mockSpawn.mock.calls[0][0];
      expect(spawnCmd).toContain("'/path/with spaces/config.json'");
      expect(spawnCmd).toContain("'--flag=value(1)'");
      // Simple args should remain unquoted
      expect(spawnCmd).toContain('--acp');
    });
  });

  // -------------------------------------------------------------------------
  // Permission handling
  // -------------------------------------------------------------------------

  describe('permission handling', () => {
    it('should auto-approve with allow_once when available', async () => {
      const mocks = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('perm-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps: mocks._deps });

      // Execute to set up connection and handlers
      await instance.execute('prompt');

      const result = mocks.permissionHandler({
        sessionId: 'test-session-123',
        toolCall: {},
        options: [
          { kind: 'allow_once', optionId: 'opt-1', name: 'Allow once' },
          { kind: 'allow_always', optionId: 'opt-2', name: 'Allow always' },
        ],
      });

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    });

    it('should fall back to allow_always when allow_once not available', async () => {
      const mocks = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('perm-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps: mocks._deps });

      await instance.execute('prompt');

      const result = mocks.permissionHandler({
        sessionId: 'test-session-123',
        toolCall: {},
        options: [
          { kind: 'allow_always', optionId: 'opt-2', name: 'Allow always' },
          { kind: 'deny', optionId: 'opt-3', name: 'Deny' },
        ],
      });

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-2' } });
    });

    it('should return cancelled when no allow option available', async () => {
      const mocks = createMockDeps('{"level":1}');
      const TestProvider = createAcpProviderClass('perm-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent', _deps: mocks._deps });

      await instance.execute('prompt');

      const result = mocks.permissionHandler({
        sessionId: 'test-session-123',
        toolCall: {},
        options: [
          { kind: 'deny', optionId: 'opt-3', name: 'Deny' },
        ],
      });

      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  // -------------------------------------------------------------------------
  // getExtractionConfig()
  // -------------------------------------------------------------------------

  describe('getExtractionConfig()', () => {
    it('should return null', () => {
      const TestProvider = createAcpProviderClass('ext-test', { command: 'myagent' });
      const instance = new TestProvider('default', { command: 'myagent' });
      expect(instance.getExtractionConfig()).toBeNull();
    });
  });
});
