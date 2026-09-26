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

// Patch child_process.spawn before the bridge is loaded (PiBridge destructures spawn at import time)
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const mockSpawn = vi.fn();
childProcess.spawn = mockSpawn;

const OmpBridge = require('../../../src/chat/omp-bridge');
const PiBridge = require('../../../src/chat/pi-bridge');
const logger = require('../../../src/utils/logger');

/**
 * Helper to create a fake child process with real-enough streams for readline.
 * Auto-responds to get_state and new_session RPC commands so that start()
 * resolves quickly. Pass respondToNewSession: false to leave new_session
 * unanswered (for exercising the timeout fallback).
 */
function createFakeProcess({ respondToNewSession = true } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdin.writable = true;
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = vi.fn((...args) => {
    origWrite(...args);
    try {
      const parsed = JSON.parse(String(args[0]).trim());
      if (parsed.type === 'get_state') {
        setImmediate(() => {
          proc.stdout.write(JSON.stringify({
            type: 'response',
            command: 'get_state',
            success: true,
            data: { sessionFile: '/tmp/auto-session.jsonl' }
          }) + '\n');
        });
      } else if (parsed.type === 'new_session' && respondToNewSession) {
        setImmediate(() => {
          proc.stdout.write(JSON.stringify({
            type: 'response',
            command: 'new_session',
            success: true,
            data: { cancelled: false }
          }) + '\n');
        });
      }
    } catch { /* not JSON, ignore */ }
  });
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  // Emit 'close' on kill so bridge.close() resolves without waiting for timers
  proc.kill = vi.fn(() => setImmediate(() => proc.emit('close', 0, null)));
  proc.pid = 54321;
  return proc;
}

/** Extract the parsed RPC frames written to a fake process's stdin. */
function writtenFrames(proc) {
  return proc.stdin.write.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0]).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('OmpBridge', () => {
  let fakeProc;

  // The bridge reads PAIR_REVIEW_OMP_CMD at construction; clear it so a shell
  // that exports it (the documented wrapper mechanism) can't flip the default
  // command/useShell assertions below.
  const origOmpCmd = process.env.PAIR_REVIEW_OMP_CMD;

  afterAll(() => {
    childProcess.spawn = realSpawn;
    if (origOmpCmd === undefined) {
      delete process.env.PAIR_REVIEW_OMP_CMD;
    } else {
      process.env.PAIR_REVIEW_OMP_CMD = origOmpCmd;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAIR_REVIEW_OMP_CMD;
    fakeProc = createFakeProcess();
    mockSpawn.mockReturnValue(fakeProc);
  });

  describe('constructor', () => {
    it('should extend PiBridge', () => {
      const bridge = new OmpBridge();
      expect(bridge).toBeInstanceOf(PiBridge);
    });

    it('should set OMP defaults', () => {
      const bridge = new OmpBridge();
      expect(bridge.piCommand).toBe('omp');
      expect(bridge.tools).toBe('read,grep,glob');
      expect(bridge.logName).toBe('OmpBridge');
      expect(bridge.cliName).toBe('OMP');
      expect(bridge.sessionFlag).toBe('--resume');
      expect(bridge.useShell).toBe(false);
    });

    it('should accept a custom command via piCommand option', () => {
      const bridge = new OmpBridge({ piCommand: '/usr/local/bin/omp' });
      expect(bridge.piCommand).toBe('/usr/local/bin/omp');
    });

    it('should use PAIR_REVIEW_OMP_CMD env var when set', () => {
      const orig = process.env.PAIR_REVIEW_OMP_CMD;
      process.env.PAIR_REVIEW_OMP_CMD = 'devx omp';
      try {
        const bridge = new OmpBridge();
        expect(bridge.piCommand).toBe('devx omp');
        expect(bridge.useShell).toBe(true);
      } finally {
        if (orig === undefined) {
          delete process.env.PAIR_REVIEW_OMP_CMD;
        } else {
          process.env.PAIR_REVIEW_OMP_CMD = orig;
        }
      }
    });

    it('should not consult PAIR_REVIEW_PI_CMD', () => {
      const orig = process.env.PAIR_REVIEW_PI_CMD;
      process.env.PAIR_REVIEW_PI_CMD = '/custom/pi';
      try {
        const bridge = new OmpBridge();
        expect(bridge.piCommand).toBe('omp');
      } finally {
        if (orig === undefined) {
          delete process.env.PAIR_REVIEW_PI_CMD;
        } else {
          process.env.PAIR_REVIEW_PI_CMD = orig;
        }
      }
    });

    it('should set useShell for multi-word commands', () => {
      const bridge = new OmpBridge({ piCommand: 'devx omp' });
      expect(bridge.useShell).toBe(true);
    });

    it('should honor an explicit useShell option', () => {
      const bridge = new OmpBridge({ piCommand: 'omp', useShell: true });
      expect(bridge.useShell).toBe(true);
    });

    it('should accept custom tools', () => {
      const bridge = new OmpBridge({ tools: 'read,bash,grep,glob' });
      expect(bridge.tools).toBe('read,bash,grep,glob');
    });

    it('should drop the skills option with a warning', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const bridge = new OmpBridge({ skills: ['/tmp/skill.md'] });
        expect(bridge.skills).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignoring skills option'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should not warn when no skills are passed', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const bridge = new OmpBridge();
        expect(bridge.skills).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('_buildArgs', () => {
    it('should include --mode rpc and OMP default tools', () => {
      const bridge = new OmpBridge();
      const args = bridge._buildArgs();
      expect(args).toContain('--mode');
      expect(args).toContain('rpc');
      expect(args).toContain('--tools');
      expect(args).toContain('read,grep,glob');
      expect(args).not.toContain('--no-session');
    });

    it('should use --resume (not --session) when sessionPath is set', () => {
      const bridge = new OmpBridge({ sessionPath: '/tmp/session.jsonl' });
      const args = bridge._buildArgs();
      expect(args).toContain('--resume');
      expect(args).toContain('/tmp/session.jsonl');
      expect(args).not.toContain('--session');
    });

    it('should not include --resume when sessionPath is null', () => {
      const bridge = new OmpBridge();
      const args = bridge._buildArgs();
      expect(args).not.toContain('--resume');
    });

    it('should never emit --skill even when skills were passed', () => {
      const bridge = new OmpBridge({ skills: ['/tmp/skill.md'] });
      const args = bridge._buildArgs();
      expect(args).not.toContain('--skill');
    });

    it('should include --no-skills when loadSkills is false', () => {
      const bridge = new OmpBridge({ loadSkills: false });
      const args = bridge._buildArgs();
      expect(args).toContain('--no-skills');
    });

    it('should include model and system prompt like PiBridge', () => {
      const bridge = new OmpBridge({ model: 'opus', systemPrompt: 'You are a reviewer' });
      const args = bridge._buildArgs();
      expect(args).toContain('--model');
      expect(args).toContain('opus');
      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('You are a reviewer');
    });

    it('should NOT split a provider/model string (OMP takes it verbatim)', () => {
      // omp-provider.js never splits provider/model, so the chat bridge must not
      // either — the same config value has to mean the same thing in both.
      const bridge = new OmpBridge({ model: 'google/gemini-2.5-pro' });
      const args = bridge._buildArgs();
      expect(args).not.toContain('--provider');
      expect(args[args.indexOf('--model') + 1]).toBe('google/gemini-2.5-pro');
    });

    it('should append extraArgs at the end of the args list', () => {
      const bridge = new OmpBridge({ extraArgs: ['--advisor'] });
      const args = bridge._buildArgs();
      expect(args.slice(-1)).toEqual(['--advisor']);
    });
  });

  describe('start', () => {
    it('should spawn the omp command with built args', async () => {
      const bridge = new OmpBridge({ sessionPath: '/tmp/session.jsonl' });
      await bridge.start();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('omp');
      expect(args).toContain('--resume');
      expect(args).toContain('/tmp/session.jsonl');
      await bridge.close();
    });

    it('should discover the session file via get_state', async () => {
      const bridge = new OmpBridge();
      const sessionEvents = [];
      bridge.on('session', (e) => sessionEvents.push(e));
      await bridge.start();
      expect(bridge.sessionPath).toBe('/tmp/auto-session.jsonl');
      expect(sessionEvents).toEqual([{ sessionFile: '/tmp/auto-session.jsonl' }]);
      await bridge.close();
    });

    it('should request a fresh session before get_state when no sessionPath is set', async () => {
      const bridge = new OmpBridge();
      await bridge.start();
      const types = writtenFrames(fakeProc).map((f) => f.type);
      expect(types.indexOf('new_session')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('new_session')).toBeLessThan(types.indexOf('get_state'));
      // The fresh session's file is still discovered and persisted
      expect(bridge.sessionPath).toBe('/tmp/auto-session.jsonl');
      await bridge.close();
    });

    it('should not send new_session when resuming from a sessionPath', async () => {
      const bridge = new OmpBridge({ sessionPath: '/tmp/session.jsonl' });
      await bridge.start();
      const types = writtenFrames(fakeProc).map((f) => f.type);
      expect(types).not.toContain('new_session');
      expect(types).toContain('get_state');
      await bridge.close();
    });

    it('should still resolve start() when new_session never gets a response', async () => {
      fakeProc = createFakeProcess({ respondToNewSession: false });
      mockSpawn.mockReturnValue(fakeProc);
      const bridge = new OmpBridge();

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const startPromise = bridge.start();
        // Let the real setImmediate ready-tick fire and new_session be written
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(writtenFrames(fakeProc).map((f) => f.type)).toContain('new_session');
        // Fire the new_session safety timeout; get_state then proceeds normally
        await vi.advanceTimersByTimeAsync(5000);
        await startPromise;
      } finally {
        vi.useRealTimers();
      }

      expect(bridge.isReady()).toBe(true);
      expect(bridge.sessionPath).toBe('/tmp/auto-session.jsonl');
      await bridge.close();
    });

    it('should still resolve start() when new_session responds with failure', async () => {
      fakeProc = createFakeProcess({ respondToNewSession: false });
      const origWrite = fakeProc.stdin.write;
      fakeProc.stdin.write = vi.fn((...args) => {
        const result = origWrite(...args);
        try {
          const parsed = JSON.parse(String(args[0]).trim());
          if (parsed.type === 'new_session') {
            setImmediate(() => {
              fakeProc.stdout.write(JSON.stringify({
                type: 'response',
                command: 'new_session',
                success: false,
                error: 'nope'
              }) + '\n');
            });
          }
        } catch { /* not JSON, ignore */ }
        return result;
      });
      mockSpawn.mockReturnValue(fakeProc);

      const bridge = new OmpBridge();
      await bridge.start();
      expect(bridge.isReady()).toBe(true);
      expect(bridge.sessionPath).toBe('/tmp/auto-session.jsonl');
      await bridge.close();
    });
  });

  describe('OMP-only events', () => {
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

    it('should log an error-level notice as an error with its source', () => {
      const bridge = new OmpBridge();

      bridge._handleLine(JSON.stringify({
        type: 'notice', level: 'error', message: 'Failed to persist session', source: 'session-persistence'
      }));

      expect(errorSpy).toHaveBeenCalledWith(
        '[OmpBridge] OMP notice (session-persistence): Failed to persist session'
      );
    });

    it('should log a warning-level notice as a warning', () => {
      const bridge = new OmpBridge();

      bridge._handleLine(JSON.stringify({
        type: 'notice', level: 'warning', message: 'Advisor "default" quota exhausted', source: 'advisor'
      }));

      expect(warnSpy).toHaveBeenCalledWith(
        '[OmpBridge] OMP notice (advisor): Advisor "default" quota exhausted'
      );
    });

    it('should log an info-level notice without a source at debug level', () => {
      const bridge = new OmpBridge();

      bridge._handleLine(JSON.stringify({ type: 'notice', level: 'info', message: 'Loaded 3 rules' }));

      expect(debugSpy).toHaveBeenCalledWith('[OmpBridge] OMP notice: Loaded 3 rules');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should not surface a notice as a chat error', () => {
      const bridge = new OmpBridge();
      const errorHandler = vi.fn();
      bridge.on('error', errorHandler);

      bridge._handleLine(JSON.stringify({ type: 'notice', level: 'error', message: 'boom' }));

      expect(errorHandler).not.toHaveBeenCalled();
    });

    it.each(['advisor_yielded', 'advisor_cost_changed', 'auto_compaction_start', 'auto_retry_start', 'todo_reminder'])(
      'should acknowledge the %s status event without reporting it as unhandled',
      (type) => {
        const bridge = new OmpBridge();

        bridge._handleLine(JSON.stringify({ type }));

        expect(debugSpy).toHaveBeenCalledWith(`[OmpBridge] ${type}`);
        expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled'));
      }
    );

    it('should still report genuinely unknown events as unhandled', () => {
      const bridge = new OmpBridge();

      bridge._handleLine(JSON.stringify({ type: 'brand_new_event' }));

      expect(debugSpy).toHaveBeenCalledWith('[OmpBridge] Unhandled event type: brand_new_event');
    });

    it('should complete once, after the advisor-steered continuation, not at the non-terminal pause', () => {
      const bridge = new OmpBridge();
      const completeHandler = vi.fn();
      bridge.on('complete', completeHandler);
      const textDelta = (delta) => JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta }
      });

      // Event shape observed from OMP RPC when an advisor steers the primary
      // after its first answer: the first agent_end is a scheduling pause.
      bridge._handleLine(JSON.stringify({ type: 'agent_start' }));
      bridge._handleLine(textDelta('First pass.'));
      bridge._handleLine(JSON.stringify({ type: 'agent_end', isTerminal: false }));
      bridge._handleLine(JSON.stringify({ type: 'advisor_yielded' }));
      bridge._handleLine(JSON.stringify({ type: 'agent_start' }));
      bridge._handleLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_start' } }));
      bridge._handleLine(textDelta('Revised after advisor feedback.'));
      expect(completeHandler).not.toHaveBeenCalled();

      bridge._handleLine(JSON.stringify({ type: 'agent_end' }));

      expect(completeHandler).toHaveBeenCalledTimes(1);
      expect(completeHandler).toHaveBeenCalledWith({
        fullText: 'First pass.\n\nRevised after advisor feedback.'
      });
    });

    it('should stay busy while paused on a background job and end the run on Stop', async () => {
      const bridge = new OmpBridge();
      await bridge.start();
      const completeHandler = vi.fn();
      bridge.on('complete', completeHandler);

      bridge._handleLine(JSON.stringify({ type: 'agent_start' }));
      bridge._handleLine(JSON.stringify({ type: 'message_start' }));
      bridge._handleLine(JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Started the suite in the background.' }
      }));
      bridge._handleLine(JSON.stringify({ type: 'message_end' }));
      bridge._handleLine(JSON.stringify({ type: 'agent_end', isTerminal: false }));
      expect(bridge.isBusy()).toBe(true);

      // OMP sends no agent_end for an abort while paused: no loop is running.
      bridge.abort();

      expect(writtenFrames(fakeProc)).toContainEqual({ type: 'abort' });
      expect(completeHandler).toHaveBeenCalledTimes(1);
      expect(completeHandler).toHaveBeenCalledWith({ fullText: 'Started the suite in the background.' });
      expect(bridge.isBusy()).toBe(false);
      await bridge.close();
    });
  });
});
