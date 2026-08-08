// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach, afterAll } from 'vitest';

/**
 * Unit tests for LLM-based JSON extraction fallback
 *
 * Tests the extraction logic in the AIProvider base class: tier-based model
 * selection, per-provider extraction configuration, and the spawn lifecycle
 * of `extractJSONWithLLM` itself (stdin closing, cancellation).
 */

const { EventEmitter } = require('events');
const fs = require('fs');

// Patch child_process.spawn with a mock that delegates to the real
// implementation by default. This MUST happen before provider.js is loaded
// (via the requires below), because it destructures spawn at import time:
//   const { spawn } = require('child_process');
// vitest's vi.mock does not intercept CJS require of Node built-ins, so the
// module object is patched directly instead. Same pattern as pi-provider.test.js.
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const mockSpawn = vi.fn((...args) => realSpawn(...args));
childProcess.spawn = mockSpawn;

// Required (not imported) so the spawn patch above lands first.
const ClaudeProvider = require('../../src/ai/claude-provider.js');
const AntigravityProvider = require('../../src/ai/antigravity-provider.js');
const CodexProvider = require('../../src/ai/codex-provider.js');
const CopilotProvider = require('../../src/ai/copilot-provider.js');
const { AIProvider } = require('../../src/ai/provider.js');
const logger = require('../../src/utils/logger');

afterAll(() => {
  childProcess.spawn = realSpawn;
});

describe('LLM-based JSON extraction fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAIR_REVIEW_CLAUDE_CMD;
    delete process.env.PAIR_REVIEW_ANTIGRAVITY_CMD;
    delete process.env.PAIR_REVIEW_CODEX_CMD;
    delete process.env.PAIR_REVIEW_COPILOT_CMD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('AIProvider.getFastTierModel', () => {
    it('should return fast-tier model for Claude (haiku)', () => {
      const provider = new ClaudeProvider('sonnet');
      expect(provider.getFastTierModel()).toBe('haiku');
    });

    it('should return fast-tier model for Antigravity (gemini-3.5-flash-low)', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      expect(provider.getFastTierModel()).toBe('gemini-3.5-flash-low');
    });

    it('should return fast-tier model for Codex (gpt-5.4-nano)', () => {
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(provider.getFastTierModel()).toBe('gpt-5.4-nano');
    });

    it('should return fast-tier model for Copilot (claude-haiku-4.6)', () => {
      const provider = new CopilotProvider('claude-sonnet-4.5');
      expect(provider.getFastTierModel()).toBe('claude-haiku-4.6');
    });

    it('should fall back to analysis model when no fast tier exists', () => {
      // All current providers have fast tiers, so this tests the fallback logic
      // by verifying it at least returns a valid model
      const provider = new ClaudeProvider('opus');
      const fastModel = provider.getFastTierModel();
      expect(fastModel).toBeTruthy();
      // Since Claude has haiku as fast tier, it returns that
      expect(fastModel).toBe('haiku');
    });
  });

  describe('AIProvider.getExtractionConfig', () => {
    describe('ClaudeProvider', () => {
      it('should return valid config', () => {
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config).toHaveProperty('useShell');
        expect(config).toHaveProperty('promptViaStdin');
      });

      it('should use stdin for prompt', () => {
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        expect(config.promptViaStdin).toBe(true);
      });

      it('should include model in args', () => {
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        // haiku resolves to its pinned cli_model (latest Haiku 4.5)
        expect(config.args).toContain('claude-haiku-4-5-20251001');
      });

      it('should use shell mode with custom command', () => {
        process.env.PAIR_REVIEW_CLAUDE_CMD = 'devx claude';
        const provider = new ClaudeProvider();
        const config = provider.getExtractionConfig('haiku');

        expect(config.useShell).toBe(true);
        expect(config.command).toContain('devx claude');
      });
    });

    describe('AntigravityProvider', () => {
      it('should return valid config', () => {
        const provider = new AntigravityProvider();
        const config = provider.getExtractionConfig('gemini-3.5-flash-low');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config.promptViaStdin).toBe(true);
      });

      it('should deliver the extraction prompt via stdin without enabling tools', () => {
        const provider = new AntigravityProvider();
        const config = provider.getExtractionConfig('gemini-3.5-flash-low');

        // agy reads the prompt from stdin (plain text); extraction is a pure
        // text->JSON reformat, so it must NOT enable the agentic tool loop.
        expect(config.promptViaStdin).toBe(true);
        expect(config.args).not.toContain('--dangerously-skip-permissions');
      });

      it('should include the resolved cliName in args', () => {
        const provider = new AntigravityProvider();
        const config = provider.getExtractionConfig('gemini-3.5-flash-low');

        // The clean id resolves to the exact `agy --model` display string.
        expect(config.args).toContain('Gemini 3.5 Flash (Low)');
      });
    });

    describe('CodexProvider', () => {
      it('should return valid config', () => {
        const provider = new CodexProvider();
        const config = provider.getExtractionConfig('gpt-5.4-nano');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config.promptViaStdin).toBe(true);
      });

      it('should use read-only sandbox for extraction', () => {
        const provider = new CodexProvider();
        const config = provider.getExtractionConfig('gpt-5.4-nano');

        // For extraction, we don't need shell commands
        expect(config.args).toContain('read-only');
      });

      it('should include model in args', () => {
        const provider = new CodexProvider();
        const config = provider.getExtractionConfig('gpt-5.4-nano');

        expect(config.args).toContain('gpt-5.4-nano');
      });
    });

    describe('CopilotProvider', () => {
      it('should return valid config', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
        expect(config).toHaveProperty('promptViaStdin');
      });

      it('should use stdin for prompt', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        // Copilot reads from stdin when no -p arg provided
        expect(config.promptViaStdin).toBe(true);
      });

      it('should include model in args', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        expect(config.args).toContain('claude-haiku-4.6');
      });

      it('should use silent mode', () => {
        const provider = new CopilotProvider();
        const config = provider.getExtractionConfig('claude-haiku-4.6');

        expect(config.args).toContain('-s');
      });
    });
  });

  describe('Model tier consistency', () => {
    it('all providers should have fast-tier models defined', () => {
      const providers = [
        { Class: ClaudeProvider, expectedFast: 'haiku' },
        { Class: AntigravityProvider, expectedFast: 'gemini-3.5-flash-low' },
        { Class: CodexProvider, expectedFast: 'gpt-5.4-nano' },
        { Class: CopilotProvider, expectedFast: 'claude-haiku-4.6' },
      ];

      for (const { Class, expectedFast } of providers) {
        const models = Class.getModels();
        const fastModel = models.find(m => m.tier === 'fast');

        expect(fastModel).toBeDefined();
        expect(fastModel.id).toBe(expectedFast);
      }
    });

    it('all providers should support extraction', () => {
      const providers = [
        ClaudeProvider,
        AntigravityProvider,
        CodexProvider,
        CopilotProvider,
      ];

      for (const ProviderClass of providers) {
        const provider = new ProviderClass();
        const config = provider.getExtractionConfig('test-model');

        expect(config).not.toBeNull();
        expect(config).toHaveProperty('command');
        expect(config).toHaveProperty('args');
      }
    });
  });

  describe('Extraction prompt handling', () => {
    it('all providers should use stdin for extraction', () => {
      const providers = [ClaudeProvider, AntigravityProvider, CodexProvider, CopilotProvider];

      for (const ProviderClass of providers) {
        const provider = new ProviderClass();
        const config = provider.getExtractionConfig('test-model');
        expect(config.promptViaStdin).toBe(true);
      }
    });
  });
});

/**
 * Spawn-lifecycle tests for the shared `extractJSONWithLLM` implementation.
 *
 * A minimal AIProvider subclass stands in for a real provider so each prompt
 * delivery mode can be exercised directly. The method under test is the real
 * one inherited from AIProvider — nothing is reimplemented here.
 */
class TestExtractionProvider extends AIProvider {
  constructor(extractionConfig) {
    super('fast-model');
    this._extractionConfig = extractionConfig;
  }

  static getProviderId() { return 'test-extraction'; }
  static getModels() { return [{ id: 'fast-model', tier: 'fast' }]; }

  getExtractionConfig() { return this._extractionConfig; }
}

/**
 * Fake ChildProcess with just enough surface for extractJSONWithLLM:
 * stdout/stderr streams, a kill spy, and a stdin double that records writes.
 */
function makeFakeChild({ pid = 4321, stdin = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  child.stdin = stdin
    ? {
      on: vi.fn(),
      write: vi.fn((_data, cb) => { if (cb) cb(null); }),
      end: vi.fn(),
    }
    : null;
  return child;
}

const ARGV_CONFIG = { command: 'muse', args: ['exec'], useShell: false, promptViaStdin: false };
const STDIN_CONFIG = { command: 'claude', args: ['-p'], useShell: false, promptViaStdin: true };
// Pi's @file syntax: the path rides argv as a single `@<path>` positional.
const AT_FILE_CONFIG = { command: 'pi', args: ['-p'], useShell: false, promptViaStdin: false, promptViaFile: true };
// Muse's named flag: the helper appends `--prompt-file <path>` itself.
const FILE_ARG_CONFIG = {
  command: 'muse', args: ['exec'], useShell: false, promptViaStdin: false, promptFileArg: '--prompt-file'
};

describe('extractJSONWithLLM spawn lifecycle', () => {
  let loggerSpies;

  beforeEach(() => {
    mockSpawn.mockClear();
    // Keep extraction chatter out of the test output without hiding failures.
    loggerSpies = ['info', 'warn', 'error', 'success', 'debug'].map(
      m => vi.spyOn(logger, m).mockImplementation(() => {})
    );
  });

  afterEach(() => {
    loggerSpies.forEach(s => s.mockRestore());
    vi.useRealTimers();
  });

  describe('stdin closing', () => {
    // Regression: the plain-argv branch used to leave stdin open. A wrapper
    // command (`devx muse --`, `docker exec ... muse`) can block on an open
    // stdin and hang until the 60s extraction timeout.
    it('ends stdin on the plain-argv branch and never writes the prompt there', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('noise {"findings": []} noise');

      // The prompt rides along as the trailing positional arg, not on stdin.
      const [, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnArgs[0]).toBe('exec');
      expect(spawnArgs[spawnArgs.length - 1]).toContain('Extract the JSON object');
      expect(child.stdin.write).not.toHaveBeenCalled();
      expect(child.stdin.end).toHaveBeenCalledTimes(1);

      child.stdout.emit('data', Buffer.from('{"findings": []}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { findings: [] } });
    });

    it('attaches a stdin error handler on the plain-argv branch so EPIPE cannot go unhandled', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw');

      const errorHandler = child.stdin.on.mock.calls.find(([evt]) => evt === 'error');
      expect(errorHandler).toBeDefined();
      expect(() => errorHandler[1](new Error('EPIPE'))).not.toThrow();

      child.emit('close', 0);
      await promise;
    });

    it('still writes the prompt and ends stdin on the stdin branch', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(STDIN_CONFIG);
      const promise = provider.extractJSONWithLLM('raw {"ok": true}');

      const [, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnArgs).toEqual(['-p']);  // prompt is NOT appended to argv
      expect(child.stdin.write).toHaveBeenCalledTimes(1);
      expect(child.stdin.write.mock.calls[0][0]).toContain('Extract the JSON object');
      expect(child.stdin.end).toHaveBeenCalledTimes(1);

      child.stdout.emit('data', Buffer.from('{"ok": true}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { ok: true } });
    });

    it('tolerates a child with no stdin stream at all', async () => {
      const child = makeFakeChild({ stdin: false });
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw {"ok": true}');

      child.stdout.emit('data', Buffer.from('{"ok": true}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { ok: true } });
    });
  });

  // Extraction input is a whole malformed model response, so the two file modes
  // exist to keep it off argv — a large one on argv fails the spawn with E2BIG.
  describe('prompt file delivery', () => {
    /** The path the helper passed to spawn, for whichever file mode is in play. */
    function tmpPathFromSpawn() {
      const [, spawnArgs] = mockSpawn.mock.calls[0];
      const last = spawnArgs[spawnArgs.length - 1];
      return last.startsWith('@') ? last.slice(1) : last;
    }

    it('writes the prompt to a temp file and appends [flag, path] for promptFileArg', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(FILE_ARG_CONFIG);
      const promise = provider.extractJSONWithLLM('noise {"findings": []} noise');

      const [, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnArgs.slice(0, 2)).toEqual(['exec', '--prompt-file']);
      expect(spawnArgs).toHaveLength(3);

      const tmpPath = tmpPathFromSpawn();
      expect(fs.readFileSync(tmpPath, 'utf8')).toContain('Extract the JSON object');
      // The prompt itself must never reach argv, and nothing goes to stdin.
      expect(spawnArgs.some(a => a.includes('Extract the JSON object'))).toBe(false);
      expect(child.stdin.write).not.toHaveBeenCalled();
      expect(child.stdin.end).toHaveBeenCalledTimes(1);

      child.stdout.emit('data', Buffer.from('{"findings": []}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { findings: [] } });

      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('removes the promptFileArg temp file when the spawn fails outright', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(FILE_ARG_CONFIG);
      const promise = provider.extractJSONWithLLM('raw');
      const tmpPath = tmpPathFromSpawn();
      expect(fs.existsSync(tmpPath)).toBe(true);

      // No `close` follows a spawn error, so the error path owns the cleanup.
      child.emit('error', new Error('spawn ENOENT'));
      await expect(promise).resolves.toEqual({ success: false, error: 'spawn ENOENT' });

      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('still appends @path for promptViaFile (Pi) rather than a named flag', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(AT_FILE_CONFIG);
      const promise = provider.extractJSONWithLLM('raw {"ok": true}');

      const [, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnArgs).toHaveLength(2);
      expect(spawnArgs[0]).toBe('-p');
      expect(spawnArgs[1]).toMatch(/^@.+/);
      expect(spawnArgs).not.toContain('--prompt-file');

      const tmpPath = tmpPathFromSpawn();
      expect(fs.readFileSync(tmpPath, 'utf8')).toContain('Extract the JSON object');
      expect(child.stdin.write).not.toHaveBeenCalled();

      child.stdout.emit('data', Buffer.from('{"ok": true}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { ok: true } });

      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('removes the promptViaFile temp file when the spawn fails outright', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(AT_FILE_CONFIG);
      const promise = provider.extractJSONWithLLM('raw');
      const tmpPath = tmpPathFromSpawn();
      expect(fs.existsSync(tmpPath)).toBe(true);

      child.emit('error', new Error('spawn ENOENT'));
      await promise;

      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('lets promptFileArg win when a config sets both file modes', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider({ ...AT_FILE_CONFIG, promptFileArg: '--prompt-file' });
      const promise = provider.extractJSONWithLLM('raw');

      const [, spawnArgs] = mockSpawn.mock.calls[0];
      expect(spawnArgs.slice(0, 2)).toEqual(['-p', '--prompt-file']);
      expect(spawnArgs[2]).not.toMatch(/^@/);

      child.emit('close', 0);
      await promise;
      expect(fs.existsSync(tmpPathFromSpawn())).toBe(false);
    });

    it('leaves no temp file behind for the argv and stdin modes', async () => {
      for (const config of [ARGV_CONFIG, STDIN_CONFIG]) {
        mockSpawn.mockClear();
        const child = makeFakeChild();
        mockSpawn.mockReturnValueOnce(child);

        const promise = new TestExtractionProvider(config).extractJSONWithLLM('raw {"ok": true}');
        const [, spawnArgs] = mockSpawn.mock.calls[0];
        expect(spawnArgs).not.toContain('--prompt-file');
        expect(spawnArgs.some(a => a.startsWith('@'))).toBe(false);

        child.stdout.emit('data', Buffer.from('{"ok": true}'));
        child.emit('close', 0);
        await expect(promise).resolves.toEqual({ success: true, data: { ok: true } });
      }
    });
  });

  describe('abortSignal support', () => {
    it('resolves normally when no abortSignal is supplied (unchanged contract)', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw');

      child.emit('close', 1);
      // Failures still come back as a resolved {success:false}, never a rejection.
      await expect(promise).resolves.toEqual({
        success: false,
        error: 'Process exited with code 1',
      });
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('does not spawn at all when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const provider = new TestExtractionProvider(ARGV_CONFIG);
      await expect(
        provider.extractJSONWithLLM('raw', { abortSignal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError', isCancellation: true });

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('kills the child and rejects with an AbortError when the signal aborts mid-flight', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const controller = new AbortController();
      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw', { abortSignal: controller.signal });

      controller.abort();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      child.emit('close', 143);
      await expect(promise).rejects.toMatchObject({ name: 'AbortError', isCancellation: true });
    });

    // The cancel must win even if the child happened to finish cleanly in the
    // race — otherwise a cancelled job reports a successful extraction.
    it('rejects on cancel even when the child closes with a parseable result', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const controller = new AbortController();
      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw', { abortSignal: controller.signal });

      controller.abort();
      child.stdout.emit('data', Buffer.from('{"findings": []}'));
      child.emit('close', 0);

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    // A spawn failure leaves the child pidless, so killChildSafely signals
    // nothing and `close` may never arrive — the cancel has to be recognized
    // on the error path too.
    it('surfaces a cancel that lands on the error path as an AbortError', async () => {
      // Not `makeFakeChild({ pid: undefined })`: the default parameter would
      // substitute a real pid. A failed spawn genuinely has no pid.
      const child = makeFakeChild();
      child.pid = undefined;
      mockSpawn.mockReturnValueOnce(child);

      const controller = new AbortController();
      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw', { abortSignal: controller.signal });

      controller.abort();
      child.emit('error', new Error('spawn ENOENT'));

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(child.kill).not.toHaveBeenCalled();
    });

    // The kill EPIPEs a pending stdin write, and that callback fires before
    // `close` does — so the write-error path has to recognize the cancel too,
    // or a cancelled call settles as an ordinary write failure.
    it('treats a cancel-induced stdin write failure as a cancel, not a write error', async () => {
      const child = makeFakeChild();
      let writeCallback;
      child.stdin.write = vi.fn((_data, cb) => { writeCallback = cb; });
      mockSpawn.mockReturnValueOnce(child);

      const controller = new AbortController();
      const provider = new TestExtractionProvider(STDIN_CONFIG);
      const promise = provider.extractJSONWithLLM('raw', { abortSignal: controller.signal });

      controller.abort();
      writeCallback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

      await expect(promise).rejects.toMatchObject({ name: 'AbortError', isCancellation: true });
    });

    // Analysis jobs reuse one per-job signal across many calls; a listener left
    // attached after each call accumulates for the life of the job.
    it('detaches the abort listener once extraction settles', async () => {
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const controller = new AbortController();
      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw', { abortSignal: controller.signal });

      child.stdout.emit('data', Buffer.from('{"ok": true}'));
      child.emit('close', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { ok: true } });

      // Aborting after the fact must not reach the already-finished child.
      controller.abort();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('reports a timeout (not a cancel) when no signal fired', async () => {
      vi.useFakeTimers();
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const provider = new TestExtractionProvider(ARGV_CONFIG);
      const promise = provider.extractJSONWithLLM('raw');

      await vi.advanceTimersByTimeAsync(60000);

      await expect(promise).resolves.toEqual({
        success: false,
        error: 'LLM extraction timed out',
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('reports a cancel when the child ignores SIGTERM until the timeout', async () => {
      vi.useFakeTimers();
      const child = makeFakeChild();
      mockSpawn.mockReturnValueOnce(child);

      const controller = new AbortController();
      const provider = new TestExtractionProvider(ARGV_CONFIG);
      // Capture the outcome up front: the rejection fires while the timers are
      // being advanced, and an unobserved rejection at that moment is reported
      // as an unhandled error even though the test later awaits it.
      const settled = provider
        .extractJSONWithLLM('raw', { abortSignal: controller.signal })
        .then(result => ({ result }), error => ({ error }));

      controller.abort();
      // Child never emits close; the extraction timeout is the only way out.
      await vi.advanceTimersByTimeAsync(60000);

      const { error } = await settled;
      expect(error).toMatchObject({ name: 'AbortError', isCancellation: true });
    });
  });
});
