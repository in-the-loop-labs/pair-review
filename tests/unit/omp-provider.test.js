// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach, afterAll } from 'vitest';

/**
 * Unit tests for OmpProvider
 *
 * These tests focus on static methods, constructor behavior, response parsing,
 * and extraction config without requiring actual CLI processes. Shared JSONL
 * parsing helpers (pi-format.js) are covered in depth by pi-provider.test.js;
 * the parsing tests here exercise the OMP wrapper around them.
 */

// Patch child_process.spawn with a mock that delegates to the real implementation
// by default. This must happen BEFORE omp-provider.js is loaded (via require below),
// because omp-provider destructures spawn at import time:
//   const { spawn } = require('child_process');
// vitest's vi.mock does not intercept CJS require for Node built-in modules,
// so we patch the module object directly instead.
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const mockSpawn = vi.fn((...args) => realSpawn(...args));
childProcess.spawn = mockSpawn;

// Mock logger to suppress output during tests
// Note: Logger exports directly via CommonJS (module.exports = new AILogger()),
// so mock must export methods at top level, not under 'default'
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

// Import after mocks are set up
const OmpProvider = require('../../src/ai/omp-provider');
const { _REVIEW_CONFIG_OVERLAY_PATH: REVIEW_CONFIG_OVERLAY_PATH } = require('../../src/ai/omp-provider');

describe('OmpProvider', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    // Restore the real spawn on child_process module
    childProcess.spawn = realSpawn;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_OMP_CMD;
    delete process.env.PAIR_REVIEW_OMP_SESSION;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(OmpProvider.getProviderName()).toBe('OMP');
    });

    it('should return correct provider ID', () => {
      expect(OmpProvider.getProviderId()).toBe('omp');
    });

    it('should return default as the default model', () => {
      expect(OmpProvider.getDefaultModel()).toBe('default');
    });

    it('should return built-in model definitions', () => {
      const models = OmpProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.map(m => m.id)).toEqual(['default']);
      expect(models[0].cli_model).toBeNull();
      expect(models[0].default).toBe(true);
    });

    it('should return install instructions with the oh-my-pi package', () => {
      const instructions = OmpProvider.getInstallInstructions();
      expect(instructions).toContain('@oh-my-pi/pi-coding-agent');
      expect(instructions).toContain('oh-my-pi');
    });

    it('should have a 15 minute default timeout', () => {
      expect(OmpProvider.defaultTimeout).toBe(900000);
    });
  });

  describe('constructor', () => {
    it('should create instance with default model when no model provided', () => {
      const provider = new OmpProvider();
      expect(provider.model).toBe('default');
    });

    it('should create instance with default model when null model provided', () => {
      const provider = new OmpProvider(null);
      expect(provider.model).toBe('default');
    });

    it('should create instance with specified model', () => {
      const provider = new OmpProvider('some-model');
      expect(provider.model).toBe('some-model');
    });

    it('should use default omp command', () => {
      const provider = new OmpProvider('default');
      expect(provider.cliCmd).toBe('omp');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_OMP_CMD environment variable', () => {
      process.env.PAIR_REVIEW_OMP_CMD = '/custom/path/omp';
      const provider = new OmpProvider('default');
      expect(provider.cliCmd).toBe('/custom/path/omp');
    });

    it('should use config command over default', () => {
      const provider = new OmpProvider('default', { command: '/opt/omp/bin/omp' });
      expect(provider.cliCmd).toBe('/opt/omp/bin/omp');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_OMP_CMD = '/env/omp';
      const provider = new OmpProvider('default', { command: '/config/omp' });
      expect(provider.cliCmd).toBe('/env/omp');
    });

    it('should use shell mode for multi-word commands', () => {
      const provider = new OmpProvider('default', { command: 'devx omp' });
      expect(provider.useShell).toBe(true);
      expect(provider.cliCmd).toBe('devx omp');
    });

    it('should configure base args correctly', () => {
      const provider = new OmpProvider('default');
      expect(provider.baseArgs).toEqual([
        '-p', '--mode', 'json',
        '--tools', 'read,bash,grep,glob',
        '--no-session',
        '--config', REVIEW_CONFIG_OVERLAY_PATH
      ]);
    });

    it('should use the OMP read-only tool set (glob, not find/ls)', () => {
      const provider = new OmpProvider('default');
      const toolsIdx = provider.baseArgs.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(provider.baseArgs[toolsIdx + 1]).toBe('read,bash,grep,glob');
    });

    it('should not include Pi-only flags (--no-prompt-templates, -e)', () => {
      const provider = new OmpProvider('default');
      expect(provider.baseArgs).not.toContain('--no-prompt-templates');
      expect(provider.baseArgs).not.toContain('-e');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new OmpProvider('default', { extra_args: ['--thinking', 'high'] });
      expect(provider.baseArgs).toContain('--thinking');
      expect(provider.baseArgs).toContain('high');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new OmpProvider('my-model', {
        models: [{ id: 'my-model', cli_model: 'anthropic/claude-opus-5', extra_args: ['--thinking', 'max'] }]
      });
      expect(provider.baseArgs).toContain('--thinking');
      expect(provider.baseArgs).toContain('max');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('anthropic/claude-opus-5');
    });

    it('should merge env from provider config', () => {
      const provider = new OmpProvider('default', { env: { MY_KEY: 'value1' } });
      expect(provider.extraEnv).toEqual(expect.objectContaining({ MY_KEY: 'value1' }));
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new OmpProvider('my-model', {
        env: { SHARED: 'provider', PROVIDER_ONLY: 'p' },
        models: [{ id: 'my-model', cli_model: 'opus', env: { SHARED: 'model' } }]
      });
      expect(provider.extraEnv.SHARED).toBe('model');
      expect(provider.extraEnv.PROVIDER_ONLY).toBe('p');
    });

    it('should not set Pi task extension env vars', () => {
      const provider = new OmpProvider('default');
      expect(provider.extraEnv).not.toHaveProperty('PI_CMD');
      expect(provider.extraEnv).not.toHaveProperty('PI_TASK_MAX_DEPTH');
    });

    it('should omit --no-session when PAIR_REVIEW_OMP_SESSION is set', () => {
      process.env.PAIR_REVIEW_OMP_SESSION = '1';
      const provider = new OmpProvider('default');
      expect(provider.baseArgs).not.toContain('--no-session');
    });

    it('should include --no-session by default', () => {
      const provider = new OmpProvider('default');
      expect(provider.baseArgs).toContain('--no-session');
    });

    it('should omit --tools in yolo mode (all tools permitted)', () => {
      const provider = new OmpProvider('default', { yolo: true });
      expect(provider.baseArgs).not.toContain('--tools');
      expect(provider.baseArgs).toContain('-p');
      expect(provider.baseArgs).toContain('--no-session');
    });

    it('should include --tools when yolo is explicitly false', () => {
      const provider = new OmpProvider('default', { yolo: false });
      expect(provider.baseArgs).toContain('--tools');
    });

    it('should add --no-skills when load_skills is false', () => {
      const provider = new OmpProvider('default', { load_skills: false });
      expect(provider.baseArgs).toContain('--no-skills');
    });

    it('should not add --no-skills when load_skills is not set (default true)', () => {
      const provider = new OmpProvider('default');
      expect(provider.baseArgs).not.toContain('--no-skills');
    });
  });

  describe('advisor handling', () => {
    it('should disable the advisor by default via the bundled config overlay', () => {
      const provider = new OmpProvider('default');
      const configIdx = provider.baseArgs.indexOf('--config');
      expect(configIdx).toBeGreaterThan(-1);
      expect(provider.baseArgs[configIdx + 1]).toBe(REVIEW_CONFIG_OVERLAY_PATH);
      expect(provider.baseArgs).not.toContain('--advisor');
    });

    it('should keep the advisor disabled when advisor is explicitly false', () => {
      const provider = new OmpProvider('default', { advisor: false });
      expect(provider.baseArgs).toContain('--config');
      expect(provider.baseArgs).not.toContain('--advisor');
    });

    it('should pass --advisor instead of the overlay when advisor is true', () => {
      const provider = new OmpProvider('default', { advisor: true });
      expect(provider.baseArgs).toContain('--advisor');
      expect(provider.baseArgs).not.toContain('--config');
    });

    it('should not treat truthy non-boolean values as opt-in', () => {
      const provider = new OmpProvider('default', { advisor: 'yes' });
      expect(provider.baseArgs).not.toContain('--advisor');
      expect(provider.baseArgs).toContain('--config');
    });

    it('should still apply the overlay in yolo mode', () => {
      const provider = new OmpProvider('default', { yolo: true });
      const configIdx = provider.baseArgs.indexOf('--config');
      expect(configIdx).toBeGreaterThan(-1);
      expect(provider.baseArgs[configIdx + 1]).toBe(REVIEW_CONFIG_OVERLAY_PATH);
    });

    it('should point the overlay at a bundled file that disables the advisor', () => {
      const fs = require('fs');
      const content = fs.readFileSync(REVIEW_CONFIG_OVERLAY_PATH, 'utf8');
      expect(content).toMatch(/advisor:\s*\n\s+enabled:\s*false/);
    });
  });

  describe('model resolution', () => {
    it('should suppress --model flag when cli_model is null (default mode)', () => {
      const provider = new OmpProvider('default');
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should fall back to default when no model provided', () => {
      const provider = new OmpProvider(null);
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should use model id as --model value for non-built-in models', () => {
      const provider = new OmpProvider('gpt-5.2');
      const modelIdx = provider.baseArgs.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(provider.baseArgs[modelIdx + 1]).toBe('gpt-5.2');
    });

    it('should pass provider/model strings to --model verbatim (no --provider split)', () => {
      const provider = new OmpProvider('google/gemini-2.5-flash');
      const modelIdx = provider.baseArgs.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(provider.baseArgs[modelIdx + 1]).toBe('google/gemini-2.5-flash');
      expect(provider.baseArgs).not.toContain('--provider');
    });

    it('should resolve cli_model from config model definitions', () => {
      const provider = new OmpProvider('fast', {
        models: [{ id: 'fast', cli_model: 'google/gemini-3.1-flash-lite' }]
      });
      const modelIdx = provider.baseArgs.indexOf('--model');
      expect(provider.baseArgs[modelIdx + 1]).toBe('google/gemini-3.1-flash-lite');
    });

    it('should suppress --model when a config model sets cli_model to null', () => {
      const provider = new OmpProvider('passthrough', {
        models: [{ id: 'passthrough', cli_model: null }]
      });
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should prefer config cli_model over built-in for the same id', () => {
      const provider = new OmpProvider('default', {
        models: [{ id: 'default', cli_model: 'opus' }]
      });
      const modelIdx = provider.baseArgs.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(provider.baseArgs[modelIdx + 1]).toBe('opus');
    });
  });

  describe('parseResponse', () => {
    it('should parse text from message_end events', () => {
      const provider = new OmpProvider('default');
      const stdout = [
        '{"type":"session","version":3,"id":"abc"}',
        '{"type":"turn_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"suggestions\\":[{\\"title\\":\\"Test\\"}]}"}]}}'
      ].join('\n');

      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(1);
      expect(result.data.suggestions[0].title).toBe('Test');
    });

    it('should parse text from agent_end events as fallback', () => {
      const provider = new OmpProvider('default');
      const stdout = JSON.stringify({
        type: 'agent_end',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }] }
        ]
      });

      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data.ok).toBe(true);
    });

    it('should skip malformed JSONL lines gracefully', () => {
      const provider = new OmpProvider('default');
      const stdout = [
        'not valid json at all {{{',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}]}}'
      ].join('\n');

      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data.ok).toBe(true);
    });

    it('should extract JSON from markdown code blocks', () => {
      const provider = new OmpProvider('default');
      const text = '```json\\n{\\"ok\\":true}\\n```';
      const stdout = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}`;

      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data.ok).toBe(true);
    });

    it('should handle empty stdout', () => {
      const provider = new OmpProvider('default');
      const result = provider.parseResponse('', 1);
      expect(result.success).toBe(false);
    });

    it('should not treat OMP event envelopes as direct JSON results when no assistant text exists', () => {
      const provider = new OmpProvider('default');
      const stdout = [
        '{"type":"session","version":3,"id":"abc"}',
        '{"type":"turn_start"}',
        '{"type":"agent_end","messages":[]}'
      ].join('\n');

      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(false);
    });

    it('should still parse direct non-event JSON output when no assistant text exists', () => {
      const provider = new OmpProvider('default');
      const stdout = '{"suggestions":[]}';
      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toEqual([]);
    });

    it('should not duplicate text from message_end and turn_end', () => {
      const provider = new OmpProvider('default');
      const text = '{\\"items\\":[1]}';
      const stdout = [
        `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}`,
        `{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}`
      ].join('\n');

      const result = provider.parseResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data.items).toEqual([1]);
    });
  });

  describe('buildArgsForModel', () => {
    it('should include base extraction args for the given model', () => {
      const provider = new OmpProvider('default');
      const args = provider.buildArgsForModel('gpt-5.2');
      expect(args).toEqual([
        '-p', '--mode', 'json',
        '--model', 'gpt-5.2',
        '--no-tools',
        '--no-session',
        '--config', REVIEW_CONFIG_OVERLAY_PATH
      ]);
    });

    it('should suppress --model for the default mode', () => {
      const provider = new OmpProvider('default');
      const args = provider.buildArgsForModel('default');
      expect(args).not.toContain('--model');
      expect(args).toContain('--no-tools');
    });

    it('should always disable the advisor for extraction, even when opted in for analysis', () => {
      const provider = new OmpProvider('default', { advisor: true });
      const args = provider.buildArgsForModel('default');
      expect(args).not.toContain('--advisor');
      const configIdx = args.indexOf('--config');
      expect(configIdx).toBeGreaterThan(-1);
      expect(args[configIdx + 1]).toBe(REVIEW_CONFIG_OVERLAY_PATH);
    });

    it('should include provider-level extra_args', () => {
      const provider = new OmpProvider('default', { extra_args: ['--service-tier', 'flex'] });
      const args = provider.buildArgsForModel('default');
      expect(args).toContain('--service-tier');
      expect(args).toContain('flex');
    });

    it('should include model-specific extra_args for matching model', () => {
      const provider = new OmpProvider('default', {
        models: [{ id: 'fast', cli_model: 'gemini-flash', extra_args: ['--thinking', 'off'] }]
      });
      const args = provider.buildArgsForModel('fast');
      expect(args).toContain('--thinking');
      expect(args).toContain('off');
      expect(args).toContain('gemini-flash');
    });

    it('should not include model-specific args for non-matching model', () => {
      const provider = new OmpProvider('default', {
        models: [{ id: 'fast', cli_model: 'gemini-flash', extra_args: ['--thinking', 'off'] }]
      });
      const args = provider.buildArgsForModel('other-model');
      expect(args).not.toContain('--thinking');
    });

    it('should omit --no-session when PAIR_REVIEW_OMP_SESSION is set', () => {
      process.env.PAIR_REVIEW_OMP_SESSION = '1';
      const provider = new OmpProvider('default');
      const args = provider.buildArgsForModel('default');
      expect(args).not.toContain('--no-session');
    });

    it('should add --no-skills when load_skills is false (mirrors the analysis run)', () => {
      const provider = new OmpProvider('default', { load_skills: false });
      const args = provider.buildArgsForModel('default');
      expect(args).toContain('--no-skills');
    });

    it('should not add --no-skills when load_skills is unset or true', () => {
      expect(new OmpProvider('default').buildArgsForModel('default')).not.toContain('--no-skills');
      expect(new OmpProvider('default', { load_skills: true }).buildArgsForModel('default')).not.toContain('--no-skills');
    });
  });

  describe('getExtractionConfig', () => {
    it('should return correct structure for non-shell mode', () => {
      const provider = new OmpProvider('default');
      const config = provider.getExtractionConfig('default');
      expect(config.command).toBe('omp');
      expect(config.useShell).toBe(false);
      expect(config.promptViaFile).toBe(true);
      expect(Array.isArray(config.args)).toBe(true);
      expect(config.args).toContain('--no-tools');
    });

    it('should use shell mode for multi-word commands', () => {
      const provider = new OmpProvider('default', { command: 'devx omp' });
      const config = provider.getExtractionConfig('default');
      expect(config.useShell).toBe(true);
      expect(config.args).toEqual([]);
      expect(config.command).toContain('devx omp');
      expect(config.command).toContain('--no-tools');
      expect(config.promptViaFile).toBe(true);
    });

    it('should quote shell-sensitive extra_args in shell mode command', () => {
      const provider = new OmpProvider('default', {
        command: 'devx omp',
        extra_args: ['--append-system-prompt', 'be careful; really']
      });
      const config = provider.getExtractionConfig('default');
      expect(config.command).toContain("'be careful; really'");
    });

    it('should include env field with extraEnv in both modes', () => {
      const nonShell = new OmpProvider('default', { env: { A: '1' } });
      expect(nonShell.getExtractionConfig('default').env).toEqual(expect.objectContaining({ A: '1' }));

      const shell = new OmpProvider('default', { command: 'devx omp', env: { B: '2' } });
      expect(shell.getExtractionConfig('default').env).toEqual(expect.objectContaining({ B: '2' }));
    });

    it('should resolve env for the extraction model, not the analysis model', () => {
      const provider = new OmpProvider('analysis-model', {
        env: { SHARED: 'provider' },
        models: [
          { id: 'analysis-model', cli_model: 'opus', env: { SHARED: 'analysis', ANALYSIS_ONLY: 'a' } },
          { id: 'extraction-model', cli_model: 'flash', env: { SHARED: 'extraction' } }
        ]
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.env).toMatchObject({ SHARED: 'extraction' });
      expect(config.env).not.toHaveProperty('ANALYSIS_ONLY');
    });

    it('should mirror --no-skills in the extraction args when load_skills is false', () => {
      const provider = new OmpProvider('default', { load_skills: false });
      const config = provider.getExtractionConfig('default');
      expect(config.args).toContain('--no-skills');
    });
  });

  // The process lifecycle (spawn / settle / abort / timeout / cleanup) is
  // deliberately shared with the Pi provider via the PiStyleProvider sibling
  // base class — OMP is a fork of Pi with a different CLI surface, not a
  // different runtime. Pin the sharing so a future edit that forks one copy
  // (leaving the other without the fix) fails loudly here.
  describe('shared Pi-style pipeline', () => {
    const PiProvider = require('../../src/ai/pi-provider');
    const { PiStyleProvider } = require('../../src/ai/pi-style-provider');

    it('shares the process-lifecycle methods with PiProvider', () => {
      expect(OmpProvider.prototype.execute).toBe(PiProvider.prototype.execute);
      expect(OmpProvider.prototype.testAvailability).toBe(PiProvider.prototype.testAvailability);
      expect(OmpProvider.prototype.getExtractionConfig).toBe(PiProvider.prototype.getExtractionConfig);
      expect(OmpProvider.prototype.parseResponse).toBe(PiProvider.prototype.parseResponse);
      expect(OmpProvider.prototype.logStreamLine).toBe(PiProvider.prototype.logStreamLine);
    });

    it('is a sibling of PiProvider (extends PiStyleProvider, not PiProvider)', () => {
      expect(Object.getPrototypeOf(OmpProvider)).toBe(PiStyleProvider);
      expect(Object.getPrototypeOf(PiProvider)).toBe(PiStyleProvider);
      expect(new OmpProvider('default')).not.toBeInstanceOf(PiProvider);
    });
  });

  describe('testAvailability', () => {
    afterEach(() => {
      delete process.env.PAIR_REVIEW_OMP_CMD;
      vi.useRealTimers();
    });

    it('should resolve true when CLI command succeeds', async () => {
      // Use 'echo' as a fake CLI that exits with 0 and outputs a version
      process.env.PAIR_REVIEW_OMP_CMD = 'echo';
      const provider = new OmpProvider('default');
      const result = await provider.testAvailability();
      expect(result).toBe(true);
    });

    it('should resolve false when CLI command fails', async () => {
      // Use a command that exits with non-zero (false always exits 1)
      process.env.PAIR_REVIEW_OMP_CMD = 'false';
      const provider = new OmpProvider('default');
      const result = await provider.testAvailability();
      expect(result).toBe(false);
    });

    it('should resolve false when CLI command not found', async () => {
      process.env.PAIR_REVIEW_OMP_CMD = '/nonexistent/binary/that/does/not/exist';
      const provider = new OmpProvider('default');
      const result = await provider.testAvailability();
      expect(result).toBe(false);
    });

    it('should pass extraEnv values to spawn env', async () => {
      const { EventEmitter } = require('events');

      const fakeChild = new EventEmitter();
      fakeChild.stdout = new EventEmitter();
      fakeChild.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default', {
        env: { MY_API_KEY: 'test-key-123' }
      });
      const resultPromise = provider.testAvailability();

      fakeChild.emit('close', 0);
      await resultPromise;

      const spawnCalls = mockSpawn.mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      const spawnOpts = lastCall[2];
      expect(spawnOpts.env).toEqual(expect.objectContaining({
        MY_API_KEY: 'test-key-123'
      }));
    });

    it('should resolve false and kill the process when CLI hangs past timeout', async () => {
      vi.useFakeTimers();
      const { EventEmitter } = require('events');

      // Create a fake child process that never emits 'close'
      const fakeChild = new EventEmitter();
      fakeChild.stdout = new EventEmitter();
      // A hung CLI has a real pid; killChildSafely skips pidless children.
      fakeChild.pid = 12345;
      fakeChild.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const resultPromise = provider.testAvailability();

      vi.advanceTimersByTime(10000);

      const result = await resultPromise;
      expect(result).toBe(false);
      expect(fakeChild.kill).toHaveBeenCalled();
    });

    it('should not kill the process when CLI exits before timeout', async () => {
      vi.useFakeTimers();
      const { EventEmitter } = require('events');

      const fakeChild = new EventEmitter();
      fakeChild.stdout = new EventEmitter();
      // pid set so "kill not called" proves the timer was cleared rather
      // than passing vacuously via killChildSafely's pidless guard.
      fakeChild.pid = 12345;
      fakeChild.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const resultPromise = provider.testAvailability();

      fakeChild.emit('close', 0);
      const result = await resultPromise;

      vi.advanceTimersByTime(10000);

      expect(result).toBe(true);
      expect(fakeChild.kill).not.toHaveBeenCalled();
    });
  });

  describe('execute @file prompt delivery', () => {
    const { EventEmitter } = require('events');
    const fs = require('fs');

    let writeFileSpy;
    let unlinkSpy;

    const makeFakeChild = () => {
      const fakeChild = new EventEmitter();
      fakeChild.stdin = { end: vi.fn() };
      fakeChild.stdout = new EventEmitter();
      fakeChild.stderr = new EventEmitter();
      fakeChild.pid = 12345;
      fakeChild.kill = vi.fn();
      return fakeChild;
    };

    beforeEach(() => {
      writeFileSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    });

    afterEach(() => {
      writeFileSpy.mockRestore();
      unlinkSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should write prompt to temp file and pass @tmpFile to spawn', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const prompt = 'Analyze this code for bugs';
      const executePromise = provider.execute(prompt, { level: 1 });

      // Verify fs.writeFileSync was called with the prompt content
      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const [tmpFilePath, writtenContent] = writeFileSpy.mock.calls[0];
      expect(tmpFilePath).toMatch(/pair-review-prompt-\d+-\d+-[0-9a-f-]+\.txt$/);
      expect(writtenContent).toBe(prompt);

      // Verify spawn was called with @tmpFile as the last positional arg
      const spawnCalls = mockSpawn.mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      const spawnArgs = lastCall[1]; // args array
      const atFileArg = spawnArgs[spawnArgs.length - 1];
      expect(atFileArg).toBe(`@${tmpFilePath}`);

      // Complete the process
      fakeChild.stdout.emit('data', Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"findings\\":[]}"}]}}\n'));
      fakeChild.emit('close', 0);

      const result = await executePromise;
      expect(result).toEqual({ findings: [] });
    });

    it('should include the advisor-disabling overlay in the spawned args', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1 });

      const spawnArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1];
      const configIdx = spawnArgs.indexOf('--config');
      expect(configIdx).toBeGreaterThan(-1);
      expect(spawnArgs[configIdx + 1]).toBe(REVIEW_CONFIG_OVERLAY_PATH);

      fakeChild.stdout.emit('data', Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n'));
      fakeChild.emit('close', 0);
      await executePromise;
    });

    it('should clean up temp file on process close', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1 });

      const [tmpFilePath] = writeFileSpy.mock.calls[0];

      fakeChild.stdout.emit('data', Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n'));
      fakeChild.emit('close', 0);

      await executePromise;

      expect(unlinkSpy).toHaveBeenCalledWith(tmpFilePath);
    });

    it('should clean up temp file on process error', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1 });

      const [tmpFilePath] = writeFileSpy.mock.calls[0];

      fakeChild.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

      await expect(executePromise).rejects.toThrow('OMP CLI not found');

      expect(unlinkSpy).toHaveBeenCalledWith(tmpFilePath);
    });

    it('should include install instructions in the ENOENT error', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1 });

      fakeChild.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

      await expect(executePromise).rejects.toThrow('@oh-my-pi/pi-coding-agent');
    });

    it('should close stdin immediately after spawn', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1 });

      // stdin.end() should be called immediately (prompt delivered via @file)
      expect(fakeChild.stdin.end).toHaveBeenCalled();

      fakeChild.stdout.emit('data', Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n'));
      fakeChild.emit('close', 0);
      await executePromise;
    });

    it('should reject with a timeout error when the CLI exceeds the timeout', async () => {
      vi.useFakeTimers();
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1, timeout: 5000 });
      // Attach the rejection expectation before advancing time so the
      // rejection is never unhandled.
      const assertion = expect(executePromise).rejects.toThrow('OMP CLI timed out after 5000ms');

      vi.advanceTimersByTime(5000);

      await assertion;
      expect(fakeChild.kill).toHaveBeenCalled();
    });

    it('should reject with an error including stderr on non-zero exit', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default');
      const executePromise = provider.execute('test prompt', { level: 1 });

      fakeChild.stderr.emit('data', Buffer.from('boom: something broke'));
      fakeChild.emit('close', 2);

      await expect(executePromise).rejects.toThrow(/OMP CLI exited with code 2.*boom: something broke/s);
    });

    it('should use a single shell command string in shell mode', async () => {
      const fakeChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new OmpProvider('default', { command: 'devx omp' });
      const executePromise = provider.execute('test prompt', { level: 1 });

      const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
      const [command, args, opts] = lastCall;
      expect(command).toMatch(/^devx omp /);
      // quoteShellArgs quotes the comma-containing tools list
      expect(command).toContain("--tools 'read,bash,grep,glob'");
      expect(args).toEqual([]);
      expect(opts.shell).toBe(true);
      expect(opts.detached).toBe(true);

      fakeChild.stdout.emit('data', Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n'));
      fakeChild.emit('close', 0);
      await executePromise;
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      expect(getProviderClass('omp')).toBe(OmpProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      expect(getRegisteredProviderIds()).toContain('omp');
    });
  });
});
