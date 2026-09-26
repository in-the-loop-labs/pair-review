// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
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
const logger = require('../../../src/utils/logger');

/**
 * Helper to create a fake child process with real-enough streams for readline.
 */
/**
 * Helper to create a fake child process with real-enough streams for readline.
 * By default, auto-responds to get_state RPC commands so that start() resolves
 * quickly without hitting the 5s timeout.  Pass { autoRespondGetState: false }
 * to suppress this and control the response manually.
 */
function createFakeProcess({ autoRespondGetState = true } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdin.writable = true;
  // Keep a spy on the original write so we can assert calls
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = vi.fn((...args) => {
    origWrite(...args);
    // Auto-respond to get_state so start() resolves promptly
    if (autoRespondGetState) {
      try {
        const parsed = JSON.parse(String(args[0]).trim());
        if (parsed.type === 'get_state') {
          setImmediate(() => {
            proc.stdout.write(JSON.stringify({
              type: 'response',
              command: 'get_state',
              success: true,
              data: { sessionFile: '/tmp/auto-session.json' }
            }) + '\n');
          });
        }
      } catch { /* not JSON, ignore */ }
    }
  });
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe('PiBridge', () => {
  let fakeProc;

  // The bridge reads PAIR_REVIEW_PI_CMD at construction; clear it so a shell
  // that exports it (the documented wrapper mechanism) can't flip the default
  // command assertions below.
  const origPiCmd = process.env.PAIR_REVIEW_PI_CMD;

  afterAll(() => {
    childProcess.spawn = realSpawn;
    if (origPiCmd === undefined) {
      delete process.env.PAIR_REVIEW_PI_CMD;
    } else {
      process.env.PAIR_REVIEW_PI_CMD = origPiCmd;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAIR_REVIEW_PI_CMD;
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
      expect(bridge.env).toEqual({});
      expect(bridge.useShell).toBe(false);
    });

    it('should accept custom options', () => {
      const bridge = new PiBridge({
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        cwd: '/tmp/work',
        systemPrompt: 'Be helpful',
        piCommand: '/usr/local/bin/pi',
        env: { PI_DEBUG: '1' },
        useShell: true,
      });
      expect(bridge.model).toBe('claude-sonnet-4');
      expect(bridge.provider).toBe('anthropic');
      expect(bridge.cwd).toBe('/tmp/work');
      expect(bridge.systemPrompt).toBe('Be helpful');
      expect(bridge.piCommand).toBe('/usr/local/bin/pi');
      expect(bridge.env).toEqual({ PI_DEBUG: '1' });
      expect(bridge.useShell).toBe(true);
    });

    it('should accept sessionPath option', () => {
      const bridge = new PiBridge({ sessionPath: '/tmp/session.json' });
      expect(bridge.sessionPath).toBe('/tmp/session.json');
    });

    it('should default sessionPath to null', () => {
      const bridge = new PiBridge();
      expect(bridge.sessionPath).toBeNull();
    });

    it('should accept extraArgs option', () => {
      const bridge = new PiBridge({ extraArgs: ['--no-extensions', '-e', '/tmp/ext'] });
      expect(bridge.extraArgs).toEqual(['--no-extensions', '-e', '/tmp/ext']);
    });

    it('should default extraArgs to empty array', () => {
      const bridge = new PiBridge();
      expect(bridge.extraArgs).toEqual([]);
    });

    it('should store loadSkills option as true by default', () => {
      const bridge = new PiBridge();
      expect(bridge.loadSkills).toBe(true);
    });

    it('should store loadSkills: false when explicitly set', () => {
      const bridge = new PiBridge({ loadSkills: false });
      expect(bridge.loadSkills).toBe(false);
    });

    it('should store loadSkills: true when explicitly set', () => {
      const bridge = new PiBridge({ loadSkills: true });
      expect(bridge.loadSkills).toBe(true);
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

    it('should split a provider/model string into --provider and --model', () => {
      const bridge = new PiBridge({ model: 'google/gemini-2.5-pro' });
      const args = bridge._buildArgs();
      expect(args).toContain('--provider');
      expect(args).toContain('google');
      expect(args).toContain('--model');
      expect(args).toContain('gemini-2.5-pro');
      expect(args).not.toContain('google/gemini-2.5-pro');
    });

    it('should split on the FIRST slash only', () => {
      const bridge = new PiBridge({ model: 'openrouter/vendor/model-x' });
      const args = bridge._buildArgs();
      expect(args[args.indexOf('--provider') + 1]).toBe('openrouter');
      expect(args[args.indexOf('--model') + 1]).toBe('vendor/model-x');
    });

    it('should not split when an explicit provider is given', () => {
      const bridge = new PiBridge({ provider: 'anthropic', model: 'google/gemini-2.5-pro' });
      const args = bridge._buildArgs();
      expect(args[args.indexOf('--provider') + 1]).toBe('anthropic');
      expect(args[args.indexOf('--model') + 1]).toBe('google/gemini-2.5-pro');
      expect(args.filter(a => a === '--provider').length).toBe(1);
    });

    it('should not treat a leading slash as a provider', () => {
      const bridge = new PiBridge({ model: '/weird-model' });
      const args = bridge._buildArgs();
      expect(args).not.toContain('--provider');
      expect(args[args.indexOf('--model') + 1]).toBe('/weird-model');
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
      expect(args).not.toContain('--continue');
    });

    it('should not include --session when sessionPath is null', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--session');
    });

    it('should append extraArgs at the end of the args list', () => {
      const bridge = new PiBridge({
        model: 'claude-sonnet-4',
        extraArgs: ['--no-extensions', '-e', '/tmp/custom-ext'],
      });
      const args = bridge._buildArgs();
      // extraArgs should be at the end
      const noExtIdx = args.indexOf('--no-extensions');
      const modeIdx = args.indexOf('--mode');
      expect(noExtIdx).toBeGreaterThan(modeIdx);
      expect(args.slice(-3)).toEqual(['--no-extensions', '-e', '/tmp/custom-ext']);
    });

    it('should not append anything when extraArgs is empty', () => {
      const bridge = new PiBridge({ extraArgs: [] });
      const args = bridge._buildArgs();
      // Should be the same as default args
      const defaultBridge = new PiBridge();
      expect(args).toEqual(defaultBridge._buildArgs());
    });

    it('should include --no-skills when loadSkills is false', () => {
      const bridge = new PiBridge({ loadSkills: false });
      const args = bridge._buildArgs();
      expect(args).toContain('--no-skills');
    });

    it('should not include --no-skills when loadSkills is true', () => {
      const bridge = new PiBridge({ loadSkills: true });
      const args = bridge._buildArgs();
      expect(args).not.toContain('--no-skills');
    });

    it('should not include --no-skills when loadSkills is not passed (default true)', () => {
      const bridge = new PiBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--no-skills');
    });

    it('should place --no-skills before extraArgs', () => {
      const bridge = new PiBridge({
        loadSkills: false,
        extraArgs: ['--verbose'],
      });
      const args = bridge._buildArgs();
      const noSkillsIdx = args.indexOf('--no-skills');
      const verboseIdx = args.indexOf('--verbose');
      expect(noSkillsIdx).toBeGreaterThan(-1);
      expect(verboseIdx).toBeGreaterThan(-1);
      expect(noSkillsIdx).toBeLessThan(verboseIdx);
    });
  });

  describe('start (spawn options)', () => {
    it('should merge env into process.env for spawn', async () => {
      const bridge = new PiBridge({ env: { PI_CUSTOM: 'yes' } });
      await bridge.start();
      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env.PI_CUSTOM).toBe('yes');
      // Should also inherit process.env
      expect(spawnOpts.env.PATH).toBe(process.env.PATH);
    });

    it('should use shell mode for multi-word commands', async () => {
      const bridge = new PiBridge({ piCommand: 'devx pi', useShell: true });
      await bridge.start();
      const spawnCmd = mockSpawn.mock.calls[0][0];
      const spawnArgs = mockSpawn.mock.calls[0][1];
      const spawnOpts = mockSpawn.mock.calls[0][2];
      // Shell mode: command + args joined into single string, empty args array
      expect(spawnCmd).toContain('devx pi');
      expect(spawnArgs).toEqual([]);
      expect(spawnOpts.shell).toBe(true);
    });

    it('should not use shell mode by default', async () => {
      const bridge = new PiBridge({ piCommand: 'pi' });
      await bridge.start();
      const spawnCmd = mockSpawn.mock.calls[0][0];
      const spawnArgs = mockSpawn.mock.calls[0][1];
      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnCmd).toBe('pi');
      expect(spawnArgs.length).toBeGreaterThan(0);
      expect(spawnOpts.shell).toBe(false);
    });

    it('should include extraArgs in spawned process args', async () => {
      const bridge = new PiBridge({
        extraArgs: ['--no-extensions', '-e', '/tmp/my-ext'],
      });
      await bridge.start();
      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--no-extensions');
      expect(spawnArgs).toContain('-e');
      expect(spawnArgs).toContain('/tmp/my-ext');
      // extraArgs should appear after the core args
      const modeIdx = spawnArgs.indexOf('--mode');
      const noExtIdx = spawnArgs.indexOf('--no-extensions');
      expect(noExtIdx).toBeGreaterThan(modeIdx);
    });

    it('should include extraArgs in shell mode spawn command', async () => {
      const bridge = new PiBridge({
        piCommand: 'devx pi',
        useShell: true,
        extraArgs: ['--no-extensions'],
      });
      await bridge.start();
      const spawnCmd = mockSpawn.mock.calls[0][0];
      expect(spawnCmd).toContain('--no-extensions');
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

    it('should route unrecognized event types through _handleOtherEvent', () => {
      const bridge = new PiBridge();
      const spy = vi.spyOn(bridge, '_handleOtherEvent');
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const event = { type: 'something_new', detail: 1 };

      try {
        bridge._handleLine(JSON.stringify(event));

        expect(spy).toHaveBeenCalledWith(event);
        expect(debugSpy).toHaveBeenCalledWith('[PiBridge] Unhandled event type: something_new');
      } finally {
        debugSpy.mockRestore();
      }
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

    it('should not emit delta for non text_delta event types when no prior text', () => {
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

    it('should inject paragraph separator on text_start when there is prior accumulated text', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      // Simulate first text block
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_start' }
      });
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_delta', delta: 'First paragraph.' }
      });
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_end' }
      });

      // Second text block starts - should inject separator
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_start' }
      });
      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_delta', delta: 'Second paragraph.' }
      });

      expect(bridge._accumulatedText).toBe('First paragraph.\n\nSecond paragraph.');
      // Delta calls: 'First paragraph.', '\n\n', 'Second paragraph.'
      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenNthCalledWith(1, { text: 'First paragraph.' });
      expect(handler).toHaveBeenNthCalledWith(2, { text: '\n\n' });
      expect(handler).toHaveBeenNthCalledWith(3, { text: 'Second paragraph.' });
    });

    it('should not inject separator on first text_start when no accumulated text', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('delta', handler);

      bridge._handleMessageUpdate({
        assistantMessageEvent: { type: 'text_start' }
      });

      expect(handler).not.toHaveBeenCalled();
      expect(bridge._accumulatedText).toBe('');
    });

    it('should handle three consecutive text blocks with proper separators', () => {
      const bridge = new PiBridge();

      // Block 1
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_start' } });
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'A' } });
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_end' } });

      // Block 2
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_start' } });
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'B' } });
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_end' } });

      // Block 3
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_start' } });
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'C' } });
      bridge._handleMessageUpdate({ assistantMessageEvent: { type: 'text_end' } });

      expect(bridge._accumulatedText).toBe('A\n\nB\n\nC');
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

    it('should not complete on a non-terminal agent_end (isTerminal: false)', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('complete', handler);
      bridge._accumulatedText = 'Waiting on the test run.';

      bridge._handleAgentEnd({ type: 'agent_end', isTerminal: false });

      expect(handler).not.toHaveBeenCalled();
      expect(bridge._accumulatedText).toBe('Waiting on the test run.');
    });

    it('should complete on an agent_end explicitly marked terminal', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('complete', handler);
      bridge._accumulatedText = 'Done.';

      bridge._handleAgentEnd({ type: 'agent_end', isTerminal: true });

      expect(handler).toHaveBeenCalledWith({ fullText: 'Done.' });
    });

    it('should complete once with text from both sides of a non-terminal pause', () => {
      const bridge = new PiBridge();
      const handler = vi.fn();
      bridge.on('complete', handler);
      const textDelta = (delta) => JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta }
      });

      bridge._handleLine(textDelta('Waiting on the test run.'));
      bridge._handleLine(JSON.stringify({ type: 'agent_end', isTerminal: false }));
      bridge._handleLine(JSON.stringify({ type: 'agent_start' }));
      bridge._handleLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }));
      bridge._handleLine(textDelta('All items are addressed.'));
      bridge._handleLine(JSON.stringify({ type: 'agent_end' }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        fullText: 'Waiting on the test run.\n\nAll items are addressed.'
      });
    });
  });

  // OMP pauses a run with `agent_end { isTerminal: false }` and resumes it in
  // a new agent loop (agent_start). The bridge must stay busy across the gap
  // and must end the run itself on the paths where OMP will not.
  describe('paused run (non-terminal agent_end)', () => {
    let debugSpy;
    let warnSpy;
    let errorSpy;

    beforeEach(() => {
      debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    const emitLine = (bridge, event) => bridge._handleLine(JSON.stringify(event));
    const textDelta = (delta) => ({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta }
    });

    /** Record complete/error/close in emission order. */
    function recordEvents(bridge) {
      const events = [];
      bridge.on('complete', (data) => events.push(['complete', data]));
      bridge.on('error', (data) => events.push(['error', data.error.message]));
      bridge.on('close', () => events.push(['close']));
      return events;
    }

    /** Start a bridge and put it in a paused run with some reply text. */
    async function startPausedBridge(text = 'Waiting on the test run.') {
      const bridge = new PiBridge();
      await bridge.start();
      emitLine(bridge, { type: 'agent_start' });
      emitLine(bridge, { type: 'message_start' });
      emitLine(bridge, textDelta(text));
      emitLine(bridge, { type: 'message_end' });
      emitLine(bridge, { type: 'agent_end', isTerminal: false });
      return bridge;
    }

    it('should report busy from the pause until the terminal agent_end', () => {
      const bridge = new PiBridge();

      emitLine(bridge, { type: 'agent_start' });
      emitLine(bridge, { type: 'message_start' });
      emitLine(bridge, textDelta('Waiting on the test run.'));
      emitLine(bridge, { type: 'message_end' });
      emitLine(bridge, { type: 'agent_end', isTerminal: false });
      expect(bridge.isBusy()).toBe(true);

      emitLine(bridge, { type: 'agent_end' });
      expect(bridge.isBusy()).toBe(false);
    });

    it('should stay busy through the resumed run, between its messages', () => {
      const bridge = new PiBridge();
      emitLine(bridge, { type: 'agent_end', isTerminal: false });

      emitLine(bridge, { type: 'agent_start' });
      emitLine(bridge, { type: 'message_start' });
      emitLine(bridge, { type: 'message_end' });
      emitLine(bridge, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' });
      expect(bridge.isBusy()).toBe(true);

      emitLine(bridge, { type: 'agent_end' });
      expect(bridge.isBusy()).toBe(false);
    });

    it('should end a paused run on abort so the reply so far is saved', async () => {
      const bridge = await startPausedBridge('Partial answer.');
      const events = recordEvents(bridge);

      bridge.abort();

      expect(fakeProc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"abort"'));
      expect(events).toEqual([['complete', { fullText: 'Partial answer.' }]]);
      expect(bridge.isBusy()).toBe(false);
    });

    it('should leave an abort after the run resumed to OMP\'s own terminal agent_end', async () => {
      const bridge = await startPausedBridge('Partial answer.');
      const events = recordEvents(bridge);
      emitLine(bridge, { type: 'agent_start' });
      emitLine(bridge, textDelta(' More.'));

      bridge.abort();
      expect(events).toEqual([]);
      expect(bridge.isBusy()).toBe(true);

      emitLine(bridge, { type: 'agent_end' });
      expect(events).toEqual([['complete', { fullText: 'Partial answer. More.' }]]);
      expect(bridge.isBusy()).toBe(false);
    });

    it('should not end the run itself on an abort outside a pause', async () => {
      const bridge = new PiBridge();
      await bridge.start();
      const events = recordEvents(bridge);
      emitLine(bridge, { type: 'agent_start' });
      emitLine(bridge, { type: 'message_start' });
      emitLine(bridge, textDelta('Streaming...'));

      bridge.abort();

      expect(events).toEqual([]);
    });

    it('should save a paused run\'s reply before reporting an unexpected exit', async () => {
      const bridge = await startPausedBridge('Partial answer.');
      const events = recordEvents(bridge);

      fakeProc.emit('close', 1, null);

      expect(events).toEqual([
        ['complete', { fullText: 'Partial answer.' }],
        ['error', 'Pi process exited (code=1, signal=null)'],
        ['close'],
      ]);
      expect(bridge.isBusy()).toBe(false);
    });

    it('should not save a partial reply on an unexpected exit outside a pause', async () => {
      const bridge = new PiBridge();
      await bridge.start();
      const events = recordEvents(bridge);
      emitLine(bridge, { type: 'message_start' });
      emitLine(bridge, textDelta('Streaming...'));

      fakeProc.emit('close', 1, null);

      expect(events).toEqual([
        ['error', 'Pi process exited (code=1, signal=null)'],
        ['close'],
      ]);
      expect(bridge.isBusy()).toBe(false);
    });

    it('should save the paused reply once and clear the pause when closed deliberately', async () => {
      const bridge = await startPausedBridge('Partial answer.');
      const events = recordEvents(bridge);
      const emitSpy = vi.spyOn(bridge, 'emit');

      const closed = bridge.close();
      fakeProc.emit('close', 0, null);
      await closed;

      // Emitted before close() detaches the session manager's listeners.
      expect(events).toEqual([['complete', { fullText: 'Partial answer.' }]]);
      // The process close event that follows adds no second complete.
      expect(emitSpy.mock.calls.filter(([name]) => name === 'complete')).toHaveLength(1);
      expect(bridge.isBusy()).toBe(false);
    });

    it('should not save a partial reply when closed deliberately outside a pause', async () => {
      const bridge = new PiBridge();
      await bridge.start();
      emitLine(bridge, { type: 'message_start' });
      emitLine(bridge, textDelta('Streaming...'));
      const emitSpy = vi.spyOn(bridge, 'emit');

      const closed = bridge.close();
      fakeProc.emit('close', 0, null);
      await closed;

      expect(emitSpy.mock.calls.map(([name]) => name)).not.toContain('complete');
    });

    it('should end a paused run when OMP reports its prompt failed', async () => {
      const bridge = await startPausedBridge('Partial answer.');
      const events = recordEvents(bridge);

      emitLine(bridge, { type: 'response', command: 'prompt', success: false, error: 'Post-run failure' });

      expect(events).toEqual([
        ['complete', { fullText: 'Partial answer.' }],
        ['error', 'Post-run failure'],
      ]);
      expect(bridge.isBusy()).toBe(false);
    });

    it('should only report the error for a failed prompt outside a pause', async () => {
      const bridge = new PiBridge();
      await bridge.start();
      const events = recordEvents(bridge);

      emitLine(bridge, { type: 'response', command: 'prompt', success: false, error: 'Busy' });

      expect(events).toEqual([['error', 'Busy']]);
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

  describe('session file discovery via get_state', () => {
    let noAutoProc;

    beforeEach(() => {
      // Use a fake process that does NOT auto-respond to get_state
      noAutoProc = createFakeProcess({ autoRespondGetState: false });
      mockSpawn.mockReturnValue(noAutoProc);
    });

    it('should send get_state after startup and emit session event on response', async () => {
      const bridge = new PiBridge();
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      // Intercept get_state write and respond with session file
      noAutoProc.stdin.write = vi.fn((data) => {
        try {
          const parsed = JSON.parse(String(data).trim());
          if (parsed.type === 'get_state') {
            setImmediate(() => {
              noAutoProc.stdout.write(JSON.stringify({
                type: 'response',
                command: 'get_state',
                success: true,
                data: { sessionFile: '/tmp/pi-session-abc.json' }
              }) + '\n');
            });
          }
        } catch { /* ignore */ }
      });

      await bridge.start();

      expect(bridge.sessionPath).toBe('/tmp/pi-session-abc.json');
      expect(sessionHandler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionFile: '/tmp/pi-session-abc.json' })
      );
    });

    it('should handle get_state response without sessionFile gracefully', async () => {
      const bridge = new PiBridge();
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      noAutoProc.stdin.write = vi.fn((data) => {
        try {
          const parsed = JSON.parse(String(data).trim());
          if (parsed.type === 'get_state') {
            setImmediate(() => {
              noAutoProc.stdout.write(JSON.stringify({
                type: 'response',
                command: 'get_state',
                success: true,
                data: {}
              }) + '\n');
            });
          }
        } catch { /* ignore */ }
      });

      await bridge.start();

      expect(bridge.sessionPath).toBeNull();
      expect(sessionHandler).not.toHaveBeenCalled();
    });

    it('should handle get_state failure gracefully', async () => {
      const bridge = new PiBridge();
      const sessionHandler = vi.fn();
      bridge.on('session', sessionHandler);

      noAutoProc.stdin.write = vi.fn((data) => {
        try {
          const parsed = JSON.parse(String(data).trim());
          if (parsed.type === 'get_state') {
            setImmediate(() => {
              noAutoProc.stdout.write(JSON.stringify({
                type: 'response',
                command: 'get_state',
                success: false,
                error: 'not supported'
              }) + '\n');
            });
          }
        } catch { /* ignore */ }
      });

      await bridge.start();

      expect(bridge.sessionPath).toBeNull();
      expect(sessionHandler).not.toHaveBeenCalled();
    });

    it('should resolve start even if get_state times out', async () => {
      vi.useFakeTimers();

      const bridge = new PiBridge();

      // Don't respond to get_state at all
      noAutoProc.stdin.write = vi.fn();

      // Start will resolve the spawn promise (via setImmediate), then
      // _querySessionFile sends get_state and waits for the response or timeout
      const startPromise = bridge.start();

      // Advance past the setImmediate for spawn ready
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the 5s timeout for get_state
      await vi.advanceTimersByTimeAsync(5000);

      await startPromise;

      expect(bridge.sessionPath).toBeNull();

      vi.useRealTimers();
    });

    it('should route get_state response via pending callback, not emit error', async () => {
      const bridge = new PiBridge();
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      noAutoProc.stdin.write = vi.fn((data) => {
        try {
          const parsed = JSON.parse(String(data).trim());
          if (parsed.type === 'get_state') {
            setImmediate(() => {
              noAutoProc.stdout.write(JSON.stringify({
                type: 'response',
                command: 'get_state',
                success: true,
                data: { sessionFile: '/tmp/sess.json' }
              }) + '\n');
            });
          }
        } catch { /* ignore */ }
      });

      await bridge.start();

      // Should NOT have emitted an error — the response was routed to the callback
      expect(errorHandler).not.toHaveBeenCalled();
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
