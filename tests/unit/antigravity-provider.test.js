// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for AntigravityProvider (the `agy` CLI, Gemini CLI's successor).
 *
 * Key differences from the old Gemini adapter these tests lock in:
 *   - the prompt is delivered on STDIN (not argv) with a fixed `-p` directive;
 *   - output is PLAIN TEXT parsed via extractJSON (no stream-json / JSONL);
 *   - execute() enables the agentic tool loop with
 *     `--dangerously-skip-permissions`; extraction does NOT.
 *
 * These tests focus on static metadata, constructor behavior, argument
 * composition, and the spawn-driven execute()/testAvailability() paths
 * without requiring the real `agy` binary.
 */

// Mock logger to suppress output during tests
// Note: Logger exports directly via CommonJS (module.exports = new AILogger()),
// so the mock must export methods at the top level, not under 'default'.
vi.mock('../../src/utils/logger', () => {
  let streamDebugEnabled = false;
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    streamDebug: vi.fn(),
    section: vi.fn(),
    isStreamDebugEnabled: () => streamDebugEnabled,
    setStreamDebugEnabled: (enabled) => { streamDebugEnabled = enabled; }
  };
});

// Spy on child_process.spawn BEFORE the provider is required, so the provider's
// destructured `spawn` reference resolves to the spy. vi.mock does not intercept
// CJS requires of Node built-in modules in vitest (see gemini/executable tests).
const { EventEmitter } = require('events');
const mockSpawn = vi.spyOn(require('child_process'), 'spawn');

// Import after mocks are set up
const AntigravityProvider = require('../../src/ai/antigravity-provider');
// Real cancellation primitives: the provider captured these at require time, so
// driving the actual activeAnalyses map (as shared.test.js does) exercises the
// same code path rather than a mock. CancellationError identity must match too.
const { CancellationError, activeAnalyses } = require('../../src/routes/shared');

/**
 * Build a minimal mock child process that mirrors the surface execute() and
 * testAvailability() touch: stdout/stderr emitters, a writable stdin, kill, pid.
 */
function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn();

  const stdin = new EventEmitter();
  stdin.written = '';
  stdin.write = vi.fn((data, cb) => {
    stdin.written += data;
    if (typeof cb === 'function') cb();
    return true;
  });
  stdin.end = vi.fn();
  child.stdin = stdin;

  return child;
}

describe('AntigravityProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAIR_REVIEW_ANTIGRAVITY_CMD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('static metadata', () => {
    it('should return correct provider name', () => {
      expect(AntigravityProvider.getProviderName()).toBe('Antigravity');
    });

    it('should return correct provider ID', () => {
      expect(AntigravityProvider.getProviderId()).toBe('antigravity');
    });

    it('should return gemini-3.1-pro-low as default model', () => {
      expect(AntigravityProvider.getDefaultModel()).toBe('gemini-3.1-pro-low');
    });

    it('should return the 4 built-in models with expected ids', () => {
      const models = AntigravityProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(4);

      const modelIds = models.map(m => m.id);
      expect(modelIds).toEqual([
        'gemini-3.5-flash-low',
        'gemini-3.5-flash-high',
        'gemini-3.1-pro-low',
        'gemini-3.1-pro-high'
      ]);
    });

    it('should map each model to the correct tier', () => {
      const models = AntigravityProvider.getModels();
      const tierMap = Object.fromEntries(models.map(m => [m.id, m.tier]));
      expect(tierMap['gemini-3.5-flash-low']).toBe('fast');
      expect(tierMap['gemini-3.5-flash-high']).toBe('fast');
      expect(tierMap['gemini-3.1-pro-low']).toBe('balanced');
      expect(tierMap['gemini-3.1-pro-high']).toBe('thorough');
    });

    it('should carry the exact `agy --model` cliName on each model', () => {
      const models = AntigravityProvider.getModels();
      const cliNameMap = Object.fromEntries(models.map(m => [m.id, m.cliName]));
      expect(cliNameMap['gemini-3.5-flash-low']).toBe('Gemini 3.5 Flash (Low)');
      expect(cliNameMap['gemini-3.5-flash-high']).toBe('Gemini 3.5 Flash (High)');
      expect(cliNameMap['gemini-3.1-pro-low']).toBe('Gemini 3.1 Pro (Low)');
      expect(cliNameMap['gemini-3.1-pro-high']).toBe('Gemini 3.1 Pro (High)');
    });

    it('should mark exactly one model (gemini-3.1-pro-low) as default', () => {
      const models = AntigravityProvider.getModels();
      const defaults = models.filter(m => m.default === true);
      expect(defaults.length).toBe(1);
      expect(defaults[0].id).toBe('gemini-3.1-pro-low');
      expect(defaults[0].tier).toBe('balanced');
    });

    it('should return install instructions with the antigravity install script', () => {
      const instructions = AntigravityProvider.getInstallInstructions();
      expect(instructions).toContain('curl -fsSL https://antigravity.google/cli/install.sh');
    });
  });

  describe('constructor: command precedence and shell mode', () => {
    it('should create instance with default model', () => {
      const provider = new AntigravityProvider();
      expect(provider.model).toBe('gemini-3.1-pro-low');
    });

    it('should create instance with a specified model', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-high');
      expect(provider.model).toBe('gemini-3.1-pro-high');
    });

    it('should use the default `agy` command with no shell', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      expect(provider.agyCmd).toBe('agy');
      expect(provider.useShell).toBe(false);
    });

    it('should respect the PAIR_REVIEW_ANTIGRAVITY_CMD environment variable', () => {
      process.env.PAIR_REVIEW_ANTIGRAVITY_CMD = '/custom/agy';
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      expect(provider.agyCmd).toBe('/custom/agy');
    });

    it('should use a config command over the default', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        command: '/path/to/agy'
      });
      expect(provider.agyCmd).toBe('/path/to/agy');
    });

    it('should prefer ENV command over config command (ENV > config > default)', () => {
      process.env.PAIR_REVIEW_ANTIGRAVITY_CMD = '/env/agy';
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        command: '/config/agy'
      });
      expect(provider.agyCmd).toBe('/env/agy');
    });

    it('should use shell mode for a multi-word command', () => {
      process.env.PAIR_REVIEW_ANTIGRAVITY_CMD = 'devx agy';
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      expect(provider.useShell).toBe(true);
      expect(provider.agyCmd).toBe('devx agy');
    });

    it('should merge env from provider config', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-high', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'gemini-3.1-pro-high', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    it('should merge model env for a model referenced by a built-in alias', () => {
      // Regression: the constructor once matched by id only, so requesting the
      // model via its alias silently dropped the override's env.
      const provider = new AntigravityProvider('gemini-3.1-pro', {
        env: { SHARED: 'provider' },
        models: [
          { id: 'gemini-3.1-pro-low', env: { SHARED: 'model', MODEL_ONLY: 'yes' } }
        ]
      });
      expect(provider.extraEnv.SHARED).toBe('model');
      expect(provider.extraEnv.MODEL_ONLY).toBe('yes');
    });
  });

  describe('_resolveCliModel', () => {
    it('should translate a clean id into its exact cliName', () => {
      const provider = new AntigravityProvider();
      expect(provider._resolveCliModel('gemini-3.1-pro-low')).toBe('Gemini 3.1 Pro (Low)');
      expect(provider._resolveCliModel('gemini-3.5-flash-high')).toBe('Gemini 3.5 Flash (High)');
    });

    it('should resolve a built-in alias to its cliName', () => {
      const provider = new AntigravityProvider();
      // gemini-3.1-pro is an alias of gemini-3.1-pro-low
      expect(provider._resolveCliModel('gemini-3.1-pro')).toBe('Gemini 3.1 Pro (Low)');
      // gemini-3.5-flash is an alias of gemini-3.5-flash-low
      expect(provider._resolveCliModel('gemini-3.5-flash')).toBe('Gemini 3.5 Flash (Low)');
    });

    it('should return an unknown id unchanged (agy falls back to its default)', () => {
      const provider = new AntigravityProvider();
      expect(provider._resolveCliModel('some-unknown-model')).toBe('some-unknown-model');
    });

    it('should prefer a config-provided cliName over the built-in', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        models: [
          { id: 'gemini-3.1-pro-low', cliName: 'Custom Display Name' }
        ]
      });
      expect(provider._resolveCliModel('gemini-3.1-pro-low')).toBe('Custom Display Name');
    });

    it('should honor the shared `cli_model` contract for config overrides', () => {
      // Users follow the documented custom-model shape (cli_model), not the
      // internal cliName. That exact string must reach `agy --model`.
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        models: [
          { id: 'gemini-3.1-pro-low', cli_model: 'Gemini 3.1 Pro (High)' }
        ]
      });
      expect(provider._resolveCliModel('gemini-3.1-pro-low')).toBe('Gemini 3.1 Pro (High)');
    });

    it('should prefer `cli_model` over `cliName` when a config override sets both', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        models: [
          { id: 'gemini-3.1-pro-low', cli_model: 'From cli_model', cliName: 'From cliName' }
        ]
      });
      expect(provider._resolveCliModel('gemini-3.1-pro-low')).toBe('From cli_model');
    });

    it('should resolve a config override targeted by canonical id when requested via a built-in alias', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro', {
        models: [
          { id: 'gemini-3.1-pro-low', cli_model: 'Overridden Via Alias' }
        ]
      });
      // gemini-3.1-pro is an alias of gemini-3.1-pro-low; the override on the
      // canonical id must still win.
      expect(provider._resolveCliModel('gemini-3.1-pro')).toBe('Overridden Via Alias');
    });
  });

  describe('_composeArgs', () => {
    it('should include --print-timeout, --model <cliName>, and -p <directive>', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const args = provider._composeArgs({
        model: 'gemini-3.1-pro-low',
        directive: 'DO THE THING',
        printTimeoutSecs: 120
      });

      const timeoutIdx = args.indexOf('--print-timeout');
      expect(timeoutIdx).toBeGreaterThanOrEqual(0);
      expect(args[timeoutIdx + 1]).toBe('120s');

      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('Gemini 3.1 Pro (Low)');

      const pIdx = args.indexOf('-p');
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(args[pIdx + 1]).toBe('DO THE THING');
    });

    it('should add --dangerously-skip-permissions when agentic:true', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const args = provider._composeArgs({
        model: 'gemini-3.1-pro-low',
        directive: 'x',
        printTimeoutSecs: 60,
        agentic: true
      });
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('should NOT add --dangerously-skip-permissions when agentic:false (extraction)', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const args = provider._composeArgs({
        model: 'gemini-3.1-pro-low',
        directive: 'x',
        printTimeoutSecs: 60,
        agentic: false
      });
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should default agentic to false when omitted', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const args = provider._composeArgs({
        model: 'gemini-3.1-pro-low',
        directive: 'x',
        printTimeoutSecs: 60
      });
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should merge provider-level and per-model extra_args (provider before model)', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        extra_args: ['--provider-flag'],
        models: [
          { id: 'gemini-3.1-pro-low', extra_args: ['--model-flag'] }
        ]
      });
      const args = provider._composeArgs({
        model: 'gemini-3.1-pro-low',
        directive: 'x',
        printTimeoutSecs: 60
      });
      expect(args).toContain('--provider-flag');
      expect(args).toContain('--model-flag');
      expect(args.indexOf('--provider-flag')).toBeLessThan(args.indexOf('--model-flag'));
    });

    it('should merge per-model extra_args for a model referenced by a built-in alias', () => {
      // Same alias-consistency guarantee as _resolveCliModel: an override keyed
      // on the canonical id must apply when the model is requested via its alias.
      const provider = new AntigravityProvider('gemini-3.1-pro', {
        models: [
          { id: 'gemini-3.1-pro-low', extra_args: ['--model-flag'] }
        ]
      });
      const args = provider._composeArgs({
        model: 'gemini-3.1-pro',
        directive: 'x',
        printTimeoutSecs: 60
      });
      expect(args).toContain('--model-flag');
    });
  });

  describe('execute', () => {
    it('should write the FULL prompt to stdin and resolve the parsed JSON on exit 0', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const registerProcess = vi.fn();
      const promise = provider.execute('THE FULL PROMPT', {
        analysisId: 'a1',
        registerProcess
      });

      child.stdout.emit('data', Buffer.from('{"suggestions":[{"id":1}]}'));
      child.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ suggestions: [{ id: 1 }] });

      // Prompt travels via stdin, not argv.
      expect(child.stdin.write).toHaveBeenCalledTimes(1);
      expect(child.stdin.write.mock.calls[0][0]).toBe('THE FULL PROMPT');
      expect(child.stdin.end).toHaveBeenCalled();

      // Process registered for cancellation.
      expect(registerProcess).toHaveBeenCalledWith('a1', child);

      // argv carries the agentic flag and the -p directive; command is `agy`.
      const [command, args] = mockSpawn.mock.calls[0];
      expect(command).toBe('agy');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('-p');
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('Gemini 3.1 Pro (Low)');
    });

    it('should reject when the CLI exits non-zero', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const promise = provider.execute('prompt', {});
      const assertion = expect(promise).rejects.toThrow(/exited with code 2/);

      child.stderr.emit('data', Buffer.from('boom'));
      child.emit('close', 2);

      await assertion;
    });

    it('should reject with install instructions when the binary is missing (ENOENT)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const promise = provider.execute('prompt', {});
      const assertion = expect(promise).rejects.toThrow(/antigravity\.google\/cli\/install\.sh/);

      const err = new Error('spawn agy ENOENT');
      err.code = 'ENOENT';
      child.emit('error', err);

      await assertion;
    });

    it('should reject when the process times out', async () => {
      vi.useFakeTimers();
      try {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const provider = new AntigravityProvider('gemini-3.1-pro-low');
        const promise = provider.execute('prompt', { timeout: 5000 });
        const assertion = expect(promise).rejects.toThrow(/timed out after 5000ms/);

        // agy owns the 5000ms budget via --print-timeout; the JS backstop fires
        // 15s later (TIMEOUT_BACKSTOP_GRACE_MS). Before the backstop the promise
        // stays pending and the child is alive.
        vi.advanceTimersByTime(5000 + 15000 - 1);
        expect(child.kill).not.toHaveBeenCalled();

        // Crossing the backstop kills the child and rejects.
        vi.advanceTimersByTime(2);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('maps the caller (council/advanced) timeout budget to agy --print-timeout', () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const promise = provider.execute('prompt', { timeout: 120000 });
      promise.catch(() => {}); // settled below; swallow the cleanup rejection

      // spawn() is called synchronously, so the argv is available immediately.
      const [, args] = mockSpawn.mock.calls[0];
      const idx = args.indexOf('--print-timeout');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe('120s'); // 120000ms budget -> 120s

      // Settle the promise so no backstop timer is left pending.
      child.emit('error', new Error('cleanup'));
    });

    // agy emits PLAIN TEXT (no JSON mode), so extractJSON usually fails and the
    // LLM-extraction fallback is the COMMON production path — its three
    // resolutions are the graceful-degradation contract analyzer.js relies on.
    describe('LLM-extraction fallback', () => {
      const PLAIN = 'agy says: I reviewed the code and found nothing. No JSON here at all.';

      it('resolves the extracted data when the LLM fallback succeeds', async () => {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const provider = new AntigravityProvider('gemini-3.1-pro-low');
        const spy = vi.spyOn(provider, 'extractJSONWithLLM')
          .mockResolvedValue({ success: true, data: { suggestions: [{ id: 7 }] } });

        const promise = provider.execute('prompt', {});
        child.stdout.emit('data', Buffer.from(PLAIN));
        child.emit('close', 0);

        expect(await promise).toEqual({ suggestions: [{ id: 7 }] });
        // The fallback receives the raw stdout to reformat.
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe(PLAIN);
      });

      it('resolves {raw, parsed:false} when the LLM fallback also fails', async () => {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const provider = new AntigravityProvider('gemini-3.1-pro-low');
        vi.spyOn(provider, 'extractJSONWithLLM')
          .mockResolvedValue({ success: false, error: 'still no json' });

        const promise = provider.execute('prompt', {});
        child.stdout.emit('data', Buffer.from(PLAIN));
        child.emit('close', 0);

        expect(await promise).toEqual({ raw: PLAIN, parsed: false });
      });

      it('resolves {raw, parsed:false} when the LLM fallback throws', async () => {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const provider = new AntigravityProvider('gemini-3.1-pro-low');
        vi.spyOn(provider, 'extractJSONWithLLM')
          .mockRejectedValue(new Error('extractor blew up'));

        const promise = provider.execute('prompt', {});
        child.stdout.emit('data', Buffer.from(PLAIN));
        child.emit('close', 0);

        expect(await promise).toEqual({ raw: PLAIN, parsed: false });
      });

      it('disarms the process backstop before the fallback so a slow extraction cannot spuriously reject', async () => {
        vi.useFakeTimers();
        try {
          const child = createMockChild();
          mockSpawn.mockReturnValue(child);

          const provider = new AntigravityProvider('gemini-3.1-pro-low');
          // A fallback that runs LONGER than the whole agy budget would trip the
          // backstop if it were still armed. It must not.
          let resolveExtraction;
          vi.spyOn(provider, 'extractJSONWithLLM').mockImplementation(
            () => new Promise((res) => { resolveExtraction = res; })
          );

          const promise = provider.execute('prompt', { timeout: 5000 });
          child.stdout.emit('data', Buffer.from(PLAIN));
          child.emit('close', 0); // clean exit -> backstop should be cleared here

          // Advance well past budget + grace; a still-armed backstop would fire.
          vi.advanceTimersByTime(5000 + 15000 + 10000);
          expect(child.kill).not.toHaveBeenCalled();

          resolveExtraction({ success: true, data: { ok: true } });
          expect(await promise).toEqual({ ok: true });
        } finally {
          vi.useRealTimers();
        }
      });
    });

    // The two cancellation paths intentionally reject with DIFFERENT error
    // classes; downstream cancel handling branches on the type, so assert the
    // class, not merely that it rejected.
    describe('cancellation', () => {
      it('rejects with an AbortError and detaches the abort listener when the signal aborts', async () => {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const controller = new AbortController();
        const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

        const provider = new AntigravityProvider('gemini-3.1-pro-low');
        const promise = provider.execute('prompt', { abortSignal: controller.signal });

        // Abort mid-flight; the wiring SIGTERMs the child, which then exits 143.
        controller.abort();
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        child.emit('close', 143);

        await expect(promise).rejects.toMatchObject({ name: 'AbortError', isCancellation: true });
        // settle() must detach the abort listener so it never outlives the process.
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      });

      it('rejects with a CancellationError when the analysis was cancelled and the CLI is SIGTERMed', async () => {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const analysisId = 'antigravity-cancel-test';
        activeAnalyses.set(analysisId, { status: 'cancelled' });
        try {
          const provider = new AntigravityProvider('gemini-3.1-pro-low');
          const promise = provider.execute('prompt', { analysisId });

          // SIGTERM exit code (143) + a cancelled analysis => CancellationError.
          child.emit('close', 143);

          await expect(promise).rejects.toBeInstanceOf(CancellationError);
        } finally {
          activeAnalyses.delete(analysisId);
        }
      });
    });
  });

  describe('getExtractionConfig', () => {
    it('should deliver the prompt via stdin and bake the extraction directive into -p', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const config = provider.getExtractionConfig('gemini-3.5-flash-low');

      expect(config.command).toBe('agy');
      expect(config.useShell).toBe(false);
      expect(config.promptViaStdin).toBe(true);

      const pIdx = config.args.indexOf('-p');
      expect(pIdx).toBeGreaterThanOrEqual(0);
      // The extraction directive is a pure text->JSON reformat instruction.
      expect(config.args[pIdx + 1]).toContain('return ONLY the raw JSON');
      expect(config.args[pIdx + 1]).toContain('Do not use any tools');

      // Fast-tier model resolves to its cliName.
      const modelIdx = config.args.indexOf('--model');
      expect(config.args[modelIdx + 1]).toBe('Gemini 3.5 Flash (Low)');
    });

    it('should NOT enable tools for extraction (no --dangerously-skip-permissions)', () => {
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const config = provider.getExtractionConfig('gemini-3.5-flash-low');
      expect(config.args).not.toContain('--dangerously-skip-permissions');
    });

    it('should use shell mode for a multi-word command', () => {
      process.env.PAIR_REVIEW_ANTIGRAVITY_CMD = 'docker run agy';
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const config = provider.getExtractionConfig('gemini-3.5-flash-low');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('docker run agy');
      expect(config.args).toEqual([]);
    });

    it('should return the merged env so the LLM fallback runs with the same environment as analysis', () => {
      // The base class spreads getExtractionConfig().env into the fallback
      // spawn. Because agy emits plain text (no JSON mode), that fallback is the
      // COMMON path — dropping env here would silently run it unconfigured.
      const provider = new AntigravityProvider('gemini-3.1-pro-low', {
        env: { PROVIDER_VAR: 'p' },
        models: [
          { id: 'gemini-3.5-flash-low', env: { MODEL_VAR: 'm' } }
        ]
      });
      const config = provider.getExtractionConfig('gemini-3.5-flash-low');
      expect(config.env).toBeTruthy();
      expect(config.env.PROVIDER_VAR).toBe('p');
      expect(config.env.MODEL_VAR).toBe('m');
    });

    it('should resolve env for the EXTRACTION model, not the analysis model', () => {
      // getExtractionConfig(model) can receive a different fast-tier model than
      // this.model; env must follow the argument, not the constructor's model.
      const provider = new AntigravityProvider('gemini-3.1-pro-high', {
        models: [
          { id: 'gemini-3.1-pro-high', env: { ANALYSIS_ONLY: 'a' } },
          { id: 'gemini-3.5-flash-low', env: { EXTRACT_ONLY: 'e' } }
        ]
      });
      const config = provider.getExtractionConfig('gemini-3.5-flash-low');
      expect(config.env.EXTRACT_ONLY).toBe('e');
      expect(config.env.ANALYSIS_ONLY).toBeUndefined();
    });
  });

  describe('getAnalysisSpawnConfig', () => {
    it('returns a spawnable { command: "agy", args } for the default model', () => {
      const provider = new AntigravityProvider();
      const { command, args } = provider.getAnalysisSpawnConfig();

      // command must be a non-empty string — this is exactly the regression the
      // security verifier crashed on (spawn(undefined, undefined)).
      expect(typeof command).toBe('string');
      expect(command).toBe('agy');

      const timeoutIdx = args.indexOf('--print-timeout');
      expect(timeoutIdx).toBeGreaterThanOrEqual(0);
      expect(args[timeoutIdx + 1]).toBe('60s');

      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('Gemini 3.1 Pro (Low)');

      // Analysis path enables the agentic tool loop.
      expect(args).toContain('--dangerously-skip-permissions');

      // The -p directive is ANALYSIS_DIRECTIVE (read-only instruction), NOT the
      // test prompt — that is what makes the write-block test meaningful.
      const pIdx = args.indexOf('-p');
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(args[pIdx + 1]).toContain('Never create, modify, or delete files');
    });

    it('honors a custom printTimeoutSecs argument', () => {
      const provider = new AntigravityProvider();
      const { args } = provider.getAnalysisSpawnConfig(120);

      const timeoutIdx = args.indexOf('--print-timeout');
      expect(timeoutIdx).toBeGreaterThanOrEqual(0);
      expect(args[timeoutIdx + 1]).toBe('120s');
    });

    it('shell-wraps a multi-word command and returns empty args', () => {
      process.env.PAIR_REVIEW_ANTIGRAVITY_CMD = 'docker run agy';
      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const { command, args } = provider.getAnalysisSpawnConfig();

      expect(command).toContain('docker run agy');
      expect(args).toEqual([]);
      // Even shell-wrapped, command is a non-empty string.
      expect(command.trim()).not.toBe('');
    });
  });

  describe('testAvailability', () => {
    it('should resolve true when `agy --version` exits 0 with a dotted version', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const promise = provider.testAvailability(5000);

      child.stdout.emit('data', Buffer.from('1.0.16\n'));
      child.emit('close', 0);

      expect(await promise).toBe(true);
    });

    it('should resolve false when the version probe errors (ENOENT)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const provider = new AntigravityProvider('gemini-3.1-pro-low');
      const promise = provider.testAvailability(5000);

      const err = new Error('spawn agy ENOENT');
      err.code = 'ENOENT';
      child.emit('error', err);

      expect(await promise).toBe(false);
    });

    it('should resolve false and kill the child when the probe times out', async () => {
      vi.useFakeTimers();
      try {
        const child = createMockChild();
        mockSpawn.mockReturnValue(child);

        const provider = new AntigravityProvider('gemini-3.1-pro-low');
        const promise = provider.testAvailability(5000);

        let settled = false;
        promise.then(() => { settled = true; });

        vi.advanceTimersByTime(4999);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(child.kill).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(await promise).toBe(false);
        expect(child.kill).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('provider registration', () => {
    it('should be registered under the id `antigravity`', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      expect(getProviderClass('antigravity')).toBe(AntigravityProvider);
    });

    it('should be listed in the registered provider ids', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      expect(getRegisteredProviderIds()).toContain('antigravity');
    });
  });
});
