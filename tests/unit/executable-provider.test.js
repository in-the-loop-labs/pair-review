// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for executable-provider.js
 *
 * Note: child_process.spawn is mocked via vi.spyOn rather than vi.mock because
 * vi.mock does not intercept CJS requires for Node built-in modules in vitest's
 * forks pool mode.
 */

// Hoist mock functions for vi.mock factories
const { mockExtractJSON } = vi.hoisted(() => ({
  mockExtractJSON: vi.fn()
}));

vi.mock('../../src/utils/logger', () => {
  let streamDebugEnabled = false;
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(),
    debug: vi.fn(), streamDebug: vi.fn(), section: vi.fn(),
    isStreamDebugEnabled: () => streamDebugEnabled,
    setStreamDebugEnabled: (enabled) => { streamDebugEnabled = enabled; }
  };
});

// Mock the provider module — vi.mock DOES intercept file-path requires
const { mockGetProviderClass, mockCreateProvider, mockGetRegisteredProviderIds } = vi.hoisted(() => ({
  mockGetProviderClass: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockGetRegisteredProviderIds: vi.fn(() => [])
}));

vi.mock('../../src/ai/provider', () => ({
  AIProvider: class AIProvider {
    constructor(model) { this.model = model; }
  },
  getProviderClass: mockGetProviderClass,
  createProvider: mockCreateProvider,
  getRegisteredProviderIds: mockGetRegisteredProviderIds,
  resolveDefaultModel: vi.fn((models) => models.find(m => m.default)?.id || models[0]?.id),
  inferModelDefaults: vi.fn((m) => m)
}));

vi.mock('../../src/utils/json-extractor', () => ({
  extractJSON: mockExtractJSON
}));

// For Node built-in and npm modules, vi.mock doesn't intercept CJS requires in
// forks pool mode. Use vi.spyOn on the actual module objects instead.
const childProcess = require('child_process');
const mockSpawn = vi.spyOn(childProcess, 'spawn');

const globModule = require('glob');
const actualMockGlob = vi.spyOn(globModule, 'glob');

const fsModule = require('fs');
const actualMockReadFile = vi.spyOn(fsModule.promises, 'readFile');

// Import source module after spy setup
const { createExecutableProviderClass } = require('../../src/ai/executable-provider');
const { AIProvider } = require('../../src/ai/provider');
const EventEmitter = require('events');

// Also spy on provider functions that the source imported at load time
const providerModule = require('../../src/ai/provider');
const actualMockGetProviderClass = vi.spyOn(providerModule, 'getProviderClass');
const actualMockCreateProvider = vi.spyOn(providerModule, 'createProvider');
const actualMockGetRegisteredProviderIds = vi.spyOn(providerModule, 'getRegisteredProviderIds');

const jsonExtractorModule = require('../../src/utils/json-extractor');
const actualMockExtractJSON = vi.spyOn(jsonExtractorModule, 'extractJSON');

// Config module: production code accesses via configModule.loadConfig() etc.,
// so spies on the require'd module object work correctly.
const configModule = require('../../src/config');
const actualMockLoadConfig = vi.spyOn(configModule, 'loadConfig');
const actualMockGetDefaultProvider = vi.spyOn(configModule, 'getDefaultProvider');

function createMockChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe('createExecutableProviderClass', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset all mocks (clear calls AND implementations) between tests
    mockSpawn.mockReset();
    actualMockGlob.mockReset();
    actualMockReadFile.mockReset();
    mockExtractJSON.mockReset();
    mockGetProviderClass.mockReset();
    mockCreateProvider.mockReset();
    mockGetRegisteredProviderIds.mockReset();
    actualMockGetProviderClass.mockReset();
    actualMockCreateProvider.mockReset();
    actualMockGetRegisteredProviderIds.mockReset();
    actualMockExtractJSON.mockReset();
    actualMockLoadConfig.mockReset();
    actualMockGetDefaultProvider.mockReset();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PAIR_REVIEW_') && !(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Factory ──────────────────────────────────────────────────────

  describe('factory function', () => {
    it('returns a class that extends AIProvider', () => {
      const P = createExecutableProviderClass('test-tool', { command: 'test-tool' });
      expect(new P()).toBeInstanceOf(AIProvider);
    });

    it('sets getProviderName from config.name', () => {
      const P = createExecutableProviderClass('test-tool', { name: 'My Tool' });
      expect(P.getProviderName()).toBe('My Tool');
    });

    it('falls back to id for getProviderName', () => {
      expect(createExecutableProviderClass('test-tool', {}).getProviderName()).toBe('test-tool');
    });

    it('sets getProviderId from id argument', () => {
      expect(createExecutableProviderClass('my-tool', {}).getProviderId()).toBe('my-tool');
    });

    it('returns models from config', () => {
      const models = [
        { id: 'fast', name: 'Fast', tier: 'fast', default: true },
        { id: 'thorough', name: 'Thorough', tier: 'thorough' }
      ];
      const result = createExecutableProviderClass('t', { models }).getModels();
      expect(result.length).toBe(2);
      expect(result[0].id).toBe('fast');
      expect(result[1].id).toBe('thorough');
    });

    it('returns default model from models list', () => {
      const models = [
        { id: 'fast', name: 'Fast', tier: 'fast' },
        { id: 'thorough', name: 'Thorough', tier: 'thorough', default: true }
      ];
      expect(createExecutableProviderClass('t', { models }).getDefaultModel()).toBe('thorough');
    });

    it('provides a default model when no models specified', () => {
      const models = createExecutableProviderClass('t', {}).getModels();
      expect(models.length).toBe(1);
      expect(models[0].id).toBe('default');
    });

    it('sets isExecutable to true', () => {
      expect(createExecutableProviderClass('t', {}).isExecutable).toBe(true);
    });

    it('sets capabilities from config', () => {
      const withCaps = createExecutableProviderClass('t1', {
        capabilities: { review_levels: true, custom_instructions: true, exclude_previous: true, consolidation: true }
      });
      expect(withCaps.capabilities).toEqual({ review_levels: true, custom_instructions: true, exclude_previous: true, consolidation: true });

      const withPartialCaps = createExecutableProviderClass('t2', {
        capabilities: { review_levels: true }
      });
      expect(withPartialCaps.capabilities).toEqual({ review_levels: true, custom_instructions: false, exclude_previous: false, consolidation: false });

      const withNoCaps = createExecutableProviderClass('t3', {});
      expect(withNoCaps.capabilities).toEqual({ review_levels: false, custom_instructions: false, exclude_previous: false, consolidation: false });

      const withExcludePrevious = createExecutableProviderClass('t4', {
        capabilities: { exclude_previous: true }
      });
      expect(withExcludePrevious.capabilities).toEqual({ review_levels: false, custom_instructions: false, exclude_previous: true, consolidation: false });
    });

    it('sets defaultTimeout from config.timeout when provided', () => {
      const withTimeout = createExecutableProviderClass('t', { timeout: 1200000 });
      expect(withTimeout.defaultTimeout).toBe(1200000);
    });

    it('does not set defaultTimeout when config.timeout is absent', () => {
      const noTimeout = createExecutableProviderClass('t', {});
      expect(noTimeout.defaultTimeout).toBeUndefined();
    });

    it('sets getInstallInstructions from config', () => {
      expect(createExecutableProviderClass('t', { installInstructions: 'pip install t' }).getInstallInstructions()).toBe('pip install t');
      expect(createExecutableProviderClass('test-tool', {}).getInstallInstructions()).toBe('Install test-tool');
    });
  });

  // ── Constructor ───────────────────────────────────────────────────

  describe('constructor', () => {
    it('uses config.command by default', () => {
      const P = createExecutableProviderClass('t', { command: '/usr/bin/t' });
      expect(new P().execCommand).toBe('/usr/bin/t');
    });

    it('uses ENV var over config.command', () => {
      process.env.PAIR_REVIEW_TEST_TOOL_CMD = '/custom/path';
      const P = createExecutableProviderClass('test-tool', { command: '/usr/bin/t' });
      expect(new P().execCommand).toBe('/custom/path');
    });

    it('converts hyphens to underscores in ENV var name', () => {
      process.env.PAIR_REVIEW_MY_TOOL_CMD = '/env/my-tool';
      const P = createExecutableProviderClass('my-tool', { command: 'my-tool' });
      expect(new P().execCommand).toBe('/env/my-tool');
    });

    it('falls back to id when no command specified', () => {
      expect(new (createExecutableProviderClass('test-tool', {}))().execCommand).toBe('test-tool');
    });

    it('sets useShell for multi-word commands', () => {
      expect(new (createExecutableProviderClass('t', { command: 'uvx my-tool' }))().useShell).toBe(true);
    });

    it('does not set useShell for single-word commands', () => {
      expect(new (createExecutableProviderClass('t', { command: 'tool' }))().useShell).toBe(false);
    });

    it('stores baseArgs from config', () => {
      expect(new (createExecutableProviderClass('t', { command: 'x', args: ['--v'] }))().baseArgs).toEqual(['--v']);
      expect(new (createExecutableProviderClass('t', { command: 'x' }))().baseArgs).toEqual([]);
    });

    it('stores diffArgs from config.diff_args', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', diff_args: ['--ignore-all-space', '-M']
      });
      expect(new P().diffArgs).toEqual(['--ignore-all-space', '-M']);
    });

    it('defaults diffArgs to empty array when not in config', () => {
      const P = createExecutableProviderClass('t', { command: 'x' });
      expect(new P().diffArgs).toEqual([]);
    });

    it('stores contextArgs, outputGlob, mappingInstructions', () => {
      const i = new (createExecutableProviderClass('t', {
        command: 'x', context_args: { title: '--t' },
        output_glob: '**/r.json', mapping_instructions: 'Map'
      }))();
      expect(i.contextArgs).toEqual({ title: '--t' });
      expect(i.outputGlob).toBe('**/r.json');
      expect(i.mappingInstructions).toBe('Map');
    });

    it('defaults outputGlob', () => {
      expect(new (createExecutableProviderClass('t', { command: 'x' }))().outputGlob).toBe('**/results.json');
    });

    it('merges config.env and configOverrides.env', () => {
      const P = createExecutableProviderClass('t', { command: 'x', env: { A: '1' } });
      expect(new P('default', { env: { B: '2' } }).extraEnv).toEqual({ A: '1', B: '2' });
      expect(new P('default', { env: { A: '2' } }).extraEnv.A).toBe('2');
    });

    it('merges model-level env into extraEnv', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', env: { A: '1' },
        models: [{ id: 'custom', tier: 'thorough', env: { C: '3' } }]
      });
      expect(new P('custom', { env: { B: '2' } }).extraEnv).toEqual({ A: '1', B: '2', C: '3' });
    });

    it('resolves model to cli_model when defined', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x',
        models: [{ id: 'opus-4-6', cli_model: 'anthropic:claude-opus-4-6', tier: 'thorough' }]
      });
      expect(new P('opus-4-6').resolvedModel).toBe('anthropic:claude-opus-4-6');
    });

    it('resolves model to id when cli_model is undefined', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x',
        models: [{ id: 'default', tier: 'thorough', default: true }]
      });
      expect(new P('default').resolvedModel).toBe('default');
    });

    it('resolves model to null when cli_model is "" (suppresses model)', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x',
        models: [{ id: 'no-model', cli_model: '', tier: 'thorough' }]
      });
      expect(new P('no-model').resolvedModel).toBeNull();
    });

    it('stores model-level extra_args', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x',
        models: [{ id: 'noisy', tier: 'thorough', extra_args: ['--critic-models', 'DISABLED'] }]
      });
      expect(new P('noisy').modelExtraArgs).toEqual(['--critic-models', 'DISABLED']);
    });

    it('stores provider-level extra_args from config and configOverrides', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', extra_args: ['--verbose']
      });
      expect(new P('default', { extra_args: ['--debug'] }).providerExtraArgs).toEqual(['--verbose', '--debug']);
    });
  });

  // ── _buildArgs ────────────────────────────────────────────────────

  describe('_buildArgs', () => {
    it('maps snake_case config keys to camelCase context keys', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', context_args: { pr_title: '--title', diff_path: '--diff' }
      });
      expect(new P()._buildArgs({ prTitle: 'Fix', diffPath: '/tmp/pr.diff' }))
        .toEqual(['--title', 'Fix', '--diff', '/tmp/pr.diff']);
    });

    it('prepends baseArgs', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', args: ['--v'], context_args: { pr_title: '--title' }
      });
      expect(new P()._buildArgs({ prTitle: 'Fix' })).toEqual(['--v', '--title', 'Fix']);
    });

    it('skips null/undefined context values', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', context_args: { pr_title: '--title', diff_path: '--diff' }
      });
      expect(new P()._buildArgs({ prTitle: 'Fix', diffPath: null })).toEqual(['--title', 'Fix']);
      expect(new P()._buildArgs({ prTitle: 'Fix' })).toEqual(['--title', 'Fix']);
    });

    it('converts numeric values to strings', () => {
      const P = createExecutableProviderClass('t', { command: 'x', context_args: { pr_number: '--pr' } });
      expect(new P()._buildArgs({ prNumber: 42 })).toEqual(['--pr', '42']);
    });

    it('returns only baseArgs when no context matches', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', args: ['--fmt', 'json'], context_args: { pr_title: '--title' }
      });
      expect(new P()._buildArgs({})).toEqual(['--fmt', 'json']);
    });

    it('includes provider extra_args after baseArgs', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', args: ['--fmt', 'json'], extra_args: ['--verbose'],
        context_args: { pr_title: '--title' }
      });
      expect(new P()._buildArgs({ prTitle: 'Fix' })).toEqual(['--fmt', 'json', '--verbose', '--title', 'Fix']);
    });

    it('includes model extra_args after provider extra_args', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', args: ['--fmt', 'json'], extra_args: ['--verbose'],
        models: [{ id: 'noisy', tier: 'thorough', extra_args: ['--critic-models', 'DISABLED'] }],
        context_args: { pr_title: '--title' }
      });
      expect(new P('noisy')._buildArgs({ prTitle: 'Fix' }))
        .toEqual(['--fmt', 'json', '--verbose', '--critic-models', 'DISABLED', '--title', 'Fix']);
    });

    it('includes configOverrides extra_args between config and model args', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x', extra_args: ['--verbose'],
        models: [{ id: 'custom', tier: 'thorough', extra_args: ['--strict'] }]
      });
      expect(new P('custom', { extra_args: ['--debug'] })._buildArgs({}))
        .toEqual(['--verbose', '--debug', '--strict']);
    });

    it('does not pass --model when cli_model is "" (model suppressed via resolvedModel=null)', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x',
        context_args: { model: '--model', output_dir: '--output-dir' },
        models: [
          { id: 'no-critic', cli_model: '', tier: 'thorough', extra_args: ['--critic-models', 'DISABLED'] }
        ]
      });
      const instance = new P('no-critic');
      // resolvedModel is null, so executableContext.model should be null
      const executableContext = {
        model: instance.resolvedModel !== undefined ? instance.resolvedModel : instance.model,
        outputDir: '/tmp/out'
      };
      expect(instance.resolvedModel).toBeNull();
      expect(instance._buildArgs(executableContext))
        .toEqual(['--critic-models', 'DISABLED', '--output-dir', '/tmp/out']);
    });

    it('passes resolved cli_model through context_args model mapping', () => {
      const P = createExecutableProviderClass('t', {
        command: 'x',
        context_args: { model: '--model', output_dir: '--output-dir' },
        models: [
          { id: 'opus-4-6', cli_model: 'anthropic:claude-opus-4-6', tier: 'thorough' }
        ]
      });
      const instance = new P('opus-4-6');
      const executableContext = {
        model: instance.resolvedModel !== undefined ? instance.resolvedModel : instance.model,
        outputDir: '/tmp/out'
      };
      expect(instance._buildArgs(executableContext))
        .toEqual(['--model', 'anthropic:claude-opus-4-6', '--output-dir', '/tmp/out']);
    });
  });

  // ── execute ───────────────────────────────────────────────────────

  describe('execute', () => {
    let instance;

    beforeEach(() => {
      const P = createExecutableProviderClass('test-tool', {
        name: 'Test Tool', command: 'test-tool',
        args: ['--format', 'json'],
        context_args: { pr_title: '--title', output_dir: '--output' },
        output_glob: 'result.json'
      });
      instance = new P();
      instance.mapOutputToSchema = vi.fn().mockResolvedValue({
        suggestions: [{ title: 'Fix this' }], summary: 'One issue found'
      });
    });

    it('spawns with correct args', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const p = instance.execute(null, {
        executableContext: { prTitle: 'Fix bug', outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      child.emit('close', 0);
      await p;

      expect(mockSpawn).toHaveBeenCalledWith(
        'test-tool',
        ['--format', 'json', '--title', 'Fix bug', '--output', '/tmp/out'],
        expect.objectContaining({ cwd: '/tmp/repo', shell: false })
      );
    });

    it('uses shell mode for multi-word commands', async () => {
      const ShellP = createExecutableProviderClass('t', {
        command: 'uvx my-tool', args: [], context_args: {}, output_glob: 'r.json'
      });
      const si = new ShellP();
      si.mapOutputToSchema = vi.fn().mockResolvedValue({ suggestions: [], summary: '' });

      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['r.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const p = si.execute(null, { executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' } });
      child.emit('close', 0);
      await p;

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('uvx my-tool'), [],
        expect.objectContaining({ shell: true })
      );
    });

    it('registers process for cancellation when analysisId provided', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const registerProcess = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' },
        analysisId: 'a-123', registerProcess
      });
      child.emit('close', 0);
      await p;
      expect(registerProcess).toHaveBeenCalledWith('a-123', child);
    });

    it('rejects with isCancellation when process is killed via cancellation', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue([]);

      const registerProcess = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' },
        analysisId: 'a-cancel', registerProcess
      });
      // Simulate external cancellation: call kill on the wrapped child
      // (which is the same object registerProcess received)
      const registeredChild = registerProcess.mock.calls[0][1];
      registeredChild.kill('SIGTERM');
      child.emit('close', null);

      await expect(p).rejects.toThrow('cancelled by user');
      try { await p; } catch (err) {
        expect(err.isCancellation).toBe(true);
      }
    });

    it('does not set isCancellation on timeout kill', async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue([]);

      const registerProcess = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' },
        analysisId: 'a-timeout', registerProcess,
        timeout: 5000
      });
      vi.advanceTimersByTime(5001);
      child.emit('close', null);

      await expect(p).rejects.toThrow('timed out');
      try { await p; } catch (err) {
        expect(err.isCancellation).toBeUndefined();
      }
      vi.useRealTimers();
    });

    it('does not call registerProcess when analysisId is absent', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const registerProcess = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, registerProcess
      });
      child.emit('close', 0);
      await p;
      expect(registerProcess).not.toHaveBeenCalled();
    });

    it('calls onStreamEvent with progress text', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const onStreamEvent = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, onStreamEvent
      });
      child.emit('close', 0);
      await p;

      expect(onStreamEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'assistant_text', text: expect.stringContaining('Test Tool') })
      );
    });

    it('emits onStreamEvent for each non-empty stdout line', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const onStreamEvent = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, onStreamEvent
      });
      child.stdout.emit('data', Buffer.from('Analyzing file1.js\nChecking rules\n\n'));
      child.emit('close', 0);
      await p;

      // First call is the initial "Running external tool" event
      // Next calls are from stdout lines
      const calls = onStreamEvent.mock.calls.map(c => c[0]);
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'assistant_text', text: 'Analyzing file1.js', timestamp: expect.any(Number) }),
        expect.objectContaining({ type: 'assistant_text', text: 'Checking rules', timestamp: expect.any(Number) })
      ]));
    });

    it('truncates stdout stream events to 200 characters', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const onStreamEvent = vi.fn();
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, onStreamEvent
      });
      const longLine = 'A'.repeat(300);
      child.stdout.emit('data', Buffer.from(longLine + '\n'));
      child.emit('close', 0);
      await p;

      const stdoutEvents = onStreamEvent.mock.calls
        .map(c => c[0])
        .filter(e => e.text.startsWith('A'));
      expect(stdoutEvents.length).toBe(1);
      expect(stdoutEvents[0].text.length).toBe(200);
    });

    it('does not emit stdout stream events when onStreamEvent is not provided', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      // Should not throw even though there is no onStreamEvent callback
      child.stdout.emit('data', Buffer.from('some output\n'));
      child.emit('close', 0);
      await p;
    });

    it('emits mapping phase stream event before mapOutputToSchema', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const events = [];
      const onStreamEvent = vi.fn((event) => events.push(event));

      // Track when mapOutputToSchema is called relative to stream events
      let mappingCalledAfterEventCount = -1;
      instance.mapOutputToSchema = vi.fn().mockImplementation(() => {
        mappingCalledAfterEventCount = events.length;
        return Promise.resolve({ suggestions: [{ title: 'Fix this' }], summary: 'One issue found' });
      });

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, onStreamEvent
      });
      child.emit('close', 0);
      await p;

      // The mapping event should be present
      const mappingEvent = events.find(e => e.text === 'Mapping tool output to suggestion format...');
      expect(mappingEvent).toBeDefined();
      expect(mappingEvent.type).toBe('assistant_text');
      expect(mappingEvent.timestamp).toEqual(expect.any(Number));

      // The mapping event should be emitted before mapOutputToSchema is called
      const mappingEventIndex = events.indexOf(mappingEvent);
      expect(mappingEventIndex).toBeLessThan(mappingCalledAfterEventCount);
    });

    it('finds result file via outputGlob and returns mapped data', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockImplementation(() => Promise.resolve(['result.json']));
      actualMockReadFile.mockImplementation(() => Promise.resolve('{}'));

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      child.emit('close', 0);
      const result = await p;

      expect(actualMockGlob).toHaveBeenCalledWith('result.json', { cwd: '/tmp/out' });
      expect(actualMockReadFile).toHaveBeenCalledWith('/tmp/out/result.json', 'utf-8');
      expect(result).toEqual({
        success: true,
        data: { suggestions: [{ title: 'Fix this' }], summary: 'One issue found' }
      });
    });

    it('rejects on non-zero exit code when no output file exists', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue([]);
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      child.stderr.emit('data', Buffer.from('something went wrong'));
      child.emit('close', 1);
      await expect(p).rejects.toThrow('exited with code 1');
    });

    it('succeeds on non-zero exit code when output file exists', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      child.stderr.emit('data', Buffer.from('some warning'));
      child.emit('close', 1);
      const result = await p;

      expect(result).toEqual({
        success: true,
        data: { suggestions: [{ title: 'Fix this' }], summary: 'One issue found' }
      });
    });

    it('kills process and rejects on timeout when no output exists', async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue([]);

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, timeout: 5000
      });
      vi.advanceTimersByTime(5001);
      // SIGTERM triggers close event
      child.emit('close', null);
      await expect(p).rejects.toThrow('timed out');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      vi.useRealTimers();
    });

    it('succeeds on timeout when output file exists', async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, timeout: 5000
      });
      vi.advanceTimersByTime(5001);
      child.emit('close', null);
      const result = await p;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toEqual({
        success: true,
        data: { suggestions: [{ title: 'Fix this' }], summary: 'One issue found' }
      });
      vi.useRealTimers();
    });

    it('rejects when no result file found', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue([]);
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      child.emit('close', 0);
      await expect(p).rejects.toThrow('No result file matching');
    });

    it('rejects when no outputDir specified', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.execute(null, { executableContext: { cwd: '/tmp/repo' } });
      child.emit('close', 0);
      await expect(p).rejects.toThrow('No output directory');
    });

    it('handles ENOENT error (command not found)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      const error = new Error('spawn test-tool ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
      await expect(p).rejects.toThrow('Command not found: test-tool');
    });

    it('passes extra env to spawned process', async () => {
      const EnvP = createExecutableProviderClass('t', {
        command: 'test-tool', env: { CUSTOM_VAR: 'hello' }, output_glob: 'result.json'
      });
      const ei = new EnvP();
      ei.mapOutputToSchema = vi.fn().mockResolvedValue({ suggestions: [], summary: '' });

      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue(['result.json']);
      actualMockReadFile.mockResolvedValue('{}');

      const p = ei.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }
      });
      child.emit('close', 0);
      await p;
      expect(mockSpawn.mock.calls[0][2].env.CUSTOM_VAR).toBe('hello');
    });

    it('does not settle twice on timeout followed by second close', async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      actualMockGlob.mockResolvedValue([]);

      const p = instance.execute(null, {
        executableContext: { outputDir: '/tmp/out', cwd: '/tmp/repo' }, timeout: 5000
      });
      vi.advanceTimersByTime(5001);
      // First close from SIGTERM — settles the promise
      child.emit('close', null);
      // Second close should be ignored
      child.emit('close', null);
      await expect(p).rejects.toThrow('timed out');
      vi.useRealTimers();
    });
  });

  // ── testAvailability ──────────────────────────────────────────────

  describe('testAvailability', () => {
    let instance;

    beforeEach(() => {
      instance = new (createExecutableProviderClass('test-tool', { command: 'test-tool' }))();
    });

    it('returns true when command exits with code 0', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.testAvailability();
      child.emit('close', 0);
      expect(await p).toBe(true);
    });

    it('returns false when command exits with non-zero code', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.testAvailability();
      child.emit('close', 1);
      expect(await p).toBe(false);
    });

    it('returns false when command not found', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.testAvailability();
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
      expect(await p).toBe(false);
    });

    it('returns false on timeout', async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.testAvailability();
      vi.advanceTimersByTime(10001);
      expect(await p).toBe(false);
      expect(child.kill).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('defaults to "true" command (always available)', async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.testAvailability();
      child.emit('close', 0);
      await p;
      expect(mockSpawn).toHaveBeenCalledWith(
        'true', [], expect.objectContaining({ shell: true })
      );
    });

    it('uses configured availability_command', async () => {
      const si = new (createExecutableProviderClass('t', {
        command: 'complex-cmd with-spaces', availability_command: 'uvx --version'
      }))();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = si.testAvailability();
      child.emit('close', 0);
      await p;
      expect(mockSpawn).toHaveBeenCalledWith(
        'uvx --version', [], expect.objectContaining({ shell: true })
      );
    });

    it('does not settle twice on timeout followed by close', async () => {
      vi.useFakeTimers();
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const p = instance.testAvailability();
      vi.advanceTimersByTime(10001);
      child.emit('close', 0);
      expect(await p).toBe(false);
      vi.useRealTimers();
    });
  });

  // ── mapOutputToSchema ─────────────────────────────────────────────

  describe('mapOutputToSchema', () => {
    /** Helper: configure loadConfig + getDefaultProvider to return a given default ID. */
    function mockConfigDefault(defaultId) {
      const fakeConfig = { default_provider: defaultId };
      actualMockLoadConfig.mockResolvedValue(fakeConfig);
      actualMockGetDefaultProvider.mockReturnValue(defaultId);
    }

    it('throws when no mapping provider is available', async () => {
      // Config returns an executable provider, and no non-exec fallback exists
      mockConfigDefault('my-exec');
      actualMockGetProviderClass.mockImplementation((pid) => {
        if (pid === 'my-exec') return { isExecutable: true };
        throw new Error('not found');
      });
      actualMockGetRegisteredProviderIds.mockReturnValue(['my-exec']);
      const P = createExecutableProviderClass('test-tool', { command: 'test-tool' });
      await expect(new P().mapOutputToSchema('{}')).rejects.toThrow('No mapping provider available');
    });

    it('throws when loadConfig fails and no providers registered', async () => {
      actualMockLoadConfig.mockRejectedValue(new Error('no config'));
      actualMockGetRegisteredProviderIds.mockReturnValue([]);
      const P = createExecutableProviderClass('test-tool', { command: 'test-tool' });
      await expect(new P().mapOutputToSchema('{}')).rejects.toThrow('No mapping provider available');
    });

    it('uses user configured default provider for mapping', async () => {
      mockConfigDefault('gemini');
      actualMockGetProviderClass.mockImplementation((pid) => {
        if (pid === 'gemini') return { isExecutable: false };
        throw new Error('not found');
      });
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue({ suggestions: [{ title: 'Mapped' }], summary: 'Sum' })
      });

      const result = await new (createExecutableProviderClass('t', { command: 't' }))().mapOutputToSchema('{}');
      expect(actualMockCreateProvider).toHaveBeenCalledWith('gemini');
      expect(result.suggestions).toEqual([{ title: 'Mapped' }]);
      expect(result.summary).toBe('Sum');
    });

    it('skips configured default when it is an executable provider', async () => {
      mockConfigDefault('my-exec');
      actualMockGetProviderClass.mockImplementation((pid) => {
        if (pid === 'my-exec') return { isExecutable: true };
        if (pid === 'claude') return { isExecutable: false };
        throw new Error('not found');
      });
      actualMockGetRegisteredProviderIds.mockReturnValue(['my-exec', 'claude']);
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue({ suggestions: [{ title: 'Claude' }], summary: 'ok' })
      });

      const result = await new (createExecutableProviderClass('t', { command: 't' }))().mapOutputToSchema('{}');
      expect(actualMockCreateProvider).toHaveBeenCalledWith('claude');
      expect(result.suggestions).toEqual([{ title: 'Claude' }]);
    });

    it('falls back to non-executable provider when config unavailable', async () => {
      actualMockLoadConfig.mockRejectedValue(new Error('no config'));
      actualMockGetProviderClass.mockImplementation((pid) => {
        if (pid === 'gemini') return { isExecutable: false };
        if (pid === 'my-exec') return { isExecutable: true };
        throw new Error('not found');
      });
      actualMockGetRegisteredProviderIds.mockReturnValue(['my-exec', 'gemini']);
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue({
          data: { suggestions: [{ title: 'Gemini' }], summary: 'ok' }
        })
      });

      const result = await new (createExecutableProviderClass('t', { command: 't' }))().mapOutputToSchema('{}');
      expect(actualMockCreateProvider).toHaveBeenCalledWith('gemini');
      expect(result.suggestions).toEqual([{ title: 'Gemini' }]);
    });

    it('handles result with data property', async () => {
      mockConfigDefault('claude');
      actualMockGetProviderClass.mockReturnValue({ isExecutable: false });
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue({
          data: { suggestions: [{ title: 'From data' }], summary: 'Data summary' }
        })
      });

      const result = await new (createExecutableProviderClass('t', { command: 't' }))().mapOutputToSchema('{}');
      expect(result.suggestions).toEqual([{ title: 'From data' }]);
      expect(result.summary).toBe('Data summary');
    });

    it('handles result with raw text via extractJSON', async () => {
      mockConfigDefault('claude');
      actualMockGetProviderClass.mockReturnValue({ isExecutable: false });
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue({ raw: 'raw text' })
      });
      actualMockExtractJSON.mockReturnValue({
        success: true,
        data: { suggestions: [{ title: 'Extracted' }], summary: 'ok' }
      });

      const result = await new (createExecutableProviderClass('t', { command: 't' }))().mapOutputToSchema('{}');
      expect(result.suggestions).toEqual([{ title: 'Extracted' }]);
      expect(result.summary).toBe('ok');
    });

    it('rejects objects without a suggestions array in last-resort fallback', async () => {
      mockConfigDefault('claude');
      actualMockGetProviderClass.mockReturnValue({ isExecutable: false });
      // Return an object with no suggestions property — e.g., { raw: '...', parsed: false }
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue({ raw: 'broken', parsed: false })
      });
      actualMockExtractJSON.mockReturnValue({ success: false });

      const P = createExecutableProviderClass('t', { command: 't' });
      await expect(new P().mapOutputToSchema('{}')).rejects.toThrow('Failed to map tool output');
    });

    it('accepts last-resort fallback when suggestions is an array', async () => {
      mockConfigDefault('claude');
      actualMockGetProviderClass.mockReturnValue({ isExecutable: false });
      // Return an object that doesn't match earlier branches but does have suggestions array
      const mockResult = { suggestions: [{ title: 'Direct' }], summary: 'ok', extraField: true };
      actualMockCreateProvider.mockReturnValue({
        execute: vi.fn().mockResolvedValue(mockResult)
      });

      const result = await new (createExecutableProviderClass('t', { command: 't' }))().mapOutputToSchema('{}');
      expect(result.suggestions).toEqual([{ title: 'Direct' }]);
      expect(result.summary).toBe('ok');
    });
  });
});
