// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for CodexProvider
 *
 * These tests focus on static methods, constructor behavior, and response parsing
 * without requiring actual CLI processes.
 */

// Mock logger to suppress output during tests
// Use actual implementation for state tracking, but mock output methods
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
const CodexProvider = require('../../src/ai/codex-provider');

describe('CodexProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_CODEX_CMD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(CodexProvider.getProviderName()).toBe('Codex');
    });

    it('should return correct provider ID', () => {
      expect(CodexProvider.getProviderId()).toBe('codex');
    });

    it('should return gpt-5.4-high as default model', () => {
      expect(CodexProvider.getDefaultModel()).toBe('gpt-5.4-high');
    });

    it('should return array of models with expected structure', () => {
      const models = CodexProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(7);

      // Check that we have the expected model IDs
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('gpt-5.4-nano');
      expect(modelIds).toContain('gpt-5.4-mini');
      expect(modelIds).toContain('gpt-5.3-codex');
      expect(modelIds).toContain('gpt-5.4-high');
      expect(modelIds).toContain('gpt-5.4-xhigh');
      expect(modelIds).toContain('gpt-5.5-high');
      expect(modelIds).toContain('gpt-5.5-xhigh');
      // Bare gpt-5.4 / gpt-5.5 (unspecified reasoning effort) are not
      // exposed as picker entries — users pick an explicit -high / -xhigh
      // variant. `gpt-5.4` is kept as an alias of gpt-5.4-high so previously
      // saved results/councils still resolve.
      expect(modelIds).not.toContain('gpt-5.4');
      expect(modelIds).not.toContain('gpt-5.5');

      const high54 = models.find(m => m.id === 'gpt-5.4-high');
      expect(high54.aliases).toContain('gpt-5.4');

      // Check model structure — default is now gpt-5.4-high (explicit reasoning)
      const defaultModel = models.find(m => m.default === true);
      expect(defaultModel).toMatchObject({
        id: 'gpt-5.4-high',
        name: 'GPT-5.4 High',
        tier: 'thorough',
        default: true
      });
      // Only one entry should carry default: true
      expect(models.filter(m => m.default === true).length).toBe(1);
    });

    it('reasoning-effort variants should declare cli_model and -c reasoning effort', () => {
      const models = CodexProvider.getModels();
      const variants = [
        { id: 'gpt-5.4-high', cliModel: 'gpt-5.4', effort: 'high' },
        { id: 'gpt-5.4-xhigh', cliModel: 'gpt-5.4', effort: 'xhigh' },
        { id: 'gpt-5.5-high', cliModel: 'gpt-5.5', effort: 'high' },
        { id: 'gpt-5.5-xhigh', cliModel: 'gpt-5.5', effort: 'xhigh' }
      ];
      for (const v of variants) {
        const model = models.find(m => m.id === v.id);
        expect(model, `missing model ${v.id}`).toBeDefined();
        expect(model.cli_model).toBe(v.cliModel);
        expect(model.extra_args).toEqual(['-c', `model_reasoning_effort="${v.effort}"`]);
        expect(model.tier).toBe('thorough');
      }
    });

    it('should return install instructions', () => {
      const instructions = CodexProvider.getInstallInstructions();
      expect(instructions).toContain('codex');
      expect(instructions).toContain('npm');
    });
  });

  describe('constructor', () => {
    it('should create instance with default model', () => {
      const provider = new CodexProvider();
      expect(provider.model).toBe('gpt-5.4-high');
    });

    it('should create instance with specified model', () => {
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(provider.model).toBe('gpt-5.4-mini');
    });

    it('should use default codex command', () => {
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(provider.command).toBe('codex');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_CODEX_CMD environment variable', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = '/custom/codex';
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(provider.command).toBe('/custom/codex');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = 'devx codex';
      const provider = new CodexProvider('gpt-5.4-mini');
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain('devx codex');
    });

    it('should quote shell-sensitive extra_args in shell mode command', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = 'devx codex --';
      const provider = new CodexProvider('gpt-5.4-mini', {
        extra_args: ['--flag', 'value(test)']
      });
      // In shell mode, the command string should have parentheses-containing args quoted
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain("'value(test)'");
    });

    it('should configure base args correctly', () => {
      const provider = new CodexProvider('gpt-5.4-nano');
      expect(provider.args).toContain('exec');
      expect(provider.args).toContain('-m');
      expect(provider.args).toContain('gpt-5.4-nano');
      expect(provider.args).toContain('--json');
      expect(provider.args).toContain('--sandbox');
      expect(provider.args).toContain('workspace-write');
      expect(provider.args).toContain('--full-auto');
      expect(provider.args).toContain('-');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new CodexProvider('gpt-5.4-mini', {
        extra_args: ['--custom-flag', '--timeout', '60']
      });
      expect(provider.args).toContain('--custom-flag');
      expect(provider.args).toContain('--timeout');
      expect(provider.args).toContain('60');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new CodexProvider('gpt-5.4-mini', {
        models: [
          { id: 'gpt-5.4-mini', extra_args: ['--special-flag'] }
        ]
      });
      expect(provider.args).toContain('--special-flag');
    });

    describe('reasoning-effort variants', () => {
      it('should pass cli_model to -m and append -c model_reasoning_effort for gpt-5.4-high', () => {
        const provider = new CodexProvider('gpt-5.4-high');
        // -m should receive the base cli_model, not the variant id
        const mIdx = provider.args.indexOf('-m');
        expect(mIdx).toBeGreaterThanOrEqual(0);
        expect(provider.args[mIdx + 1]).toBe('gpt-5.4');
        expect(provider.args).not.toContain('gpt-5.4-high');

        // -c 'model_reasoning_effort="high"' must appear as adjacent args
        const effortIdx = provider.args.indexOf('model_reasoning_effort="high"');
        expect(effortIdx).toBeGreaterThanOrEqual(1);
        expect(provider.args[effortIdx - 1]).toBe('-c');
      });

      it('should use xhigh effort for gpt-5.4-xhigh', () => {
        const provider = new CodexProvider('gpt-5.4-xhigh');
        const mIdx = provider.args.indexOf('-m');
        expect(provider.args[mIdx + 1]).toBe('gpt-5.4');
        const effortIdx = provider.args.indexOf('model_reasoning_effort="xhigh"');
        expect(effortIdx).toBeGreaterThanOrEqual(1);
        expect(provider.args[effortIdx - 1]).toBe('-c');
      });

      it('should pass gpt-5.5 as base model for gpt-5.5-high variant', () => {
        const provider = new CodexProvider('gpt-5.5-high');
        const mIdx = provider.args.indexOf('-m');
        expect(provider.args[mIdx + 1]).toBe('gpt-5.5');
        expect(provider.args).toContain('model_reasoning_effort="high"');
      });

      it('should pass gpt-5.5 as base model for gpt-5.5-xhigh variant', () => {
        const provider = new CodexProvider('gpt-5.5-xhigh');
        const mIdx = provider.args.indexOf('-m');
        expect(provider.args[mIdx + 1]).toBe('gpt-5.5');
        expect(provider.args).toContain('model_reasoning_effort="xhigh"');
      });

      it('should place stdin marker `-` AFTER reasoning extra_args in non-shell mode', () => {
        // Regression: `-` is the positional stdin marker for `codex exec`.
        // It must appear after `-c model_reasoning_effort="..."` or the
        // reasoning override is silently ignored.
        const provider = new CodexProvider('gpt-5.4-high');
        const dashIdx = provider.args.lastIndexOf('-');
        const effortIdx = provider.args.indexOf('model_reasoning_effort="high"');
        expect(dashIdx).toBe(provider.args.length - 1);
        expect(effortIdx).toBeLessThan(dashIdx);
      });

      it('should place stdin marker `-` AFTER reasoning extra_args in shell mode', () => {
        process.env.PAIR_REVIEW_CODEX_CMD = 'devx codex';
        const provider = new CodexProvider('gpt-5.4-high');
        // In shell mode, args are baked into the command string
        expect(provider.useShell).toBe(true);
        const effortPos = provider.command.indexOf('model_reasoning_effort=');
        const stdinPos = provider.command.lastIndexOf(' -');
        expect(effortPos).toBeGreaterThanOrEqual(0);
        expect(stdinPos).toBeGreaterThan(effortPos);
        expect(provider.command.endsWith(' -')).toBe(true);
      });

      it('should treat legacy "gpt-5.4" model ID as an alias of gpt-5.4-high', () => {
        const provider = new CodexProvider('gpt-5.4');
        // this.model reflects what the caller asked for (unchanged)
        expect(provider.model).toBe('gpt-5.4');
        // but the resolved CLI args match the gpt-5.4-high variant
        const mIdx = provider.args.indexOf('-m');
        expect(provider.args[mIdx + 1]).toBe('gpt-5.4');
        expect(provider.args).toContain('model_reasoning_effort="high"');
      });

      it('getExtractionConfig should also apply cli_model + reasoning effort', () => {
        const provider = new CodexProvider('gpt-5.4-mini');
        const config = provider.getExtractionConfig('gpt-5.5-xhigh');
        const mIdx = config.args.indexOf('-m');
        expect(config.args[mIdx + 1]).toBe('gpt-5.5');
        expect(config.args).toContain('model_reasoning_effort="xhigh"');
        // stdin marker stays at the very end
        expect(config.args[config.args.length - 1]).toBe('-');
      });
    });

    it('should use config command over default', () => {
      const provider = new CodexProvider('gpt-5.4-mini', {
        command: '/path/to/codex'
      });
      expect(provider.command).toBe('/path/to/codex');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = '/env/codex';
      const provider = new CodexProvider('gpt-5.4-mini', {
        command: '/config/codex'
      });
      expect(provider.command).toBe('/env/codex');
    });

    it('should merge env from provider config', () => {
      const provider = new CodexProvider('gpt-5.4-mini', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new CodexProvider('gpt-5.4-mini', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'gpt-5.4-mini', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    describe('yolo mode', () => {
      it('should include sandbox restrictions by default and no dangerously-bypass flag', () => {
        const provider = new CodexProvider('gpt-5.4-nano');
        expect(provider.args).toContain('--sandbox');
        expect(provider.args).toContain('workspace-write');
        expect(provider.args).toContain('--full-auto');
        expect(provider.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      });

      it('should use --dangerously-bypass-approvals-and-sandbox when yolo is true', () => {
        const provider = new CodexProvider('gpt-5.4-nano', { yolo: true });
        expect(provider.args).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(provider.args).not.toContain('--sandbox');
        expect(provider.args).not.toContain('workspace-write');
        expect(provider.args).not.toContain('--full-auto');
      });

      it('should include sandbox restrictions when yolo is explicitly false', () => {
        const provider = new CodexProvider('gpt-5.4-nano', { yolo: false });
        expect(provider.args).toContain('--sandbox');
        expect(provider.args).toContain('workspace-write');
        expect(provider.args).toContain('--full-auto');
        expect(provider.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      });
    });
  });

  describe('parseCodexResponse', () => {
    let provider;

    beforeEach(() => {
      provider = new CodexProvider('gpt-5.4-mini');
    });

    describe('single agent_message extraction', () => {
      it('should extract JSON from single agent_message item', () => {
        const stdout = [
          '{"type": "thread.started", "session": {"id": "123"}}',
          '{"type": "turn.started"}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"findings\\": []}"}}',
          '{"type": "turn.completed", "usage": {}}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ findings: [] });
      });

      it('should handle agent_message with embedded JSON in text', () => {
        const stdout = JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Here is the analysis: {"suggestions": [{"id": 1}]}'
          }
        });

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ suggestions: [{ id: 1 }] });
      });
    });

    describe('multiple agent_message accumulation (bug fix)', () => {
      it('should accumulate text from multiple agent_message events', () => {
        // This is the key test for the bug fix: multiple agent_message events
        // should have their text accumulated, not overwritten
        const stdout = [
          '{"type": "thread.started"}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"part1\\":"}}',
          '{"type": "item.completed", "item": {"type": "reasoning", "text": "thinking..."}}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": " \\"value\\", \\"part2\\": 42}"}}',
          '{"type": "turn.completed"}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ part1: 'value', part2: 42 });
      });

      it('should accumulate text when tool use creates multiple agent_message events', () => {
        // Simulates what happens when Codex uses a tool and produces multiple messages
        const stdout = [
          '{"type": "thread.started", "session": {}}',
          '{"type": "turn.started"}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "Let me analyze..."}}',
          '{"type": "item.completed", "item": {"type": "tool_call", "name": "read_file"}}',
          '{"type": "item.completed", "item": {"type": "tool_result", "content": "file contents"}}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "Based on the file, here is the result: {\\"issues\\": [\\"bug1\\"]}"}}',
          '{"type": "turn.completed"}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        // The JSON is extracted from the accumulated text
        expect(result.data).toEqual({ issues: ['bug1'] });
      });

      it('should handle three or more agent_message events', () => {
        const stdout = [
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"a\\":"}}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": " 1, \\"b\\":"}}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": " 2, \\"c\\": 3}"}}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ a: 1, b: 2, c: 3 });
      });
    });

    describe('no agent_message fallback', () => {
      it('should try extractJSON from stdout when no agent_message found', () => {
        // When there's no agent_message, it should fall back to extracting JSON from raw stdout
        const stdout = '{"type": "result", "data": {"extracted": true}}';

        const result = provider.parseCodexResponse(stdout, 1);
        // extractJSON should find the nested object
        expect(result.success).toBe(true);
      });

      it('should return error when no JSON found anywhere', () => {
        // Use text that has no extractable JSON objects (no {...} patterns)
        const stdout = [
          'plain text line 1',
          'plain text line 2',
          'no json here'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('malformed JSONL handling', () => {
      it('should skip invalid JSON lines gracefully', () => {
        const stdout = [
          '{"type": "thread.started"}',
          'not valid json at all',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"valid\\": true}"}}',
          '{ broken'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ valid: true });
      });

      it('should handle empty lines', () => {
        const stdout = [
          '',
          '{"type": "thread.started"}',
          '',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"data\\": 123}"}}',
          ''
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ data: 123 });
      });

      it('should handle completely malformed input by trying extractJSON', () => {
        const stdout = '{"broken json';

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('agent_message without JSON', () => {
      it('should return error when agent_message text is not JSON', () => {
        const stdout = JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Just plain text without any JSON structure.'
          }
        });

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('not valid JSON');
      });

      it('should handle agent_message with markdown-wrapped JSON', () => {
        const stdout = JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '```json\n{"wrapped": true}\n```'
          }
        });

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ wrapped: true });
      });
    });

    describe('edge cases', () => {
      it('should handle empty response string', () => {
        const result = provider.parseCodexResponse('', 1);
        expect(result.success).toBe(false);
      });

      it('should handle whitespace-only response', () => {
        const result = provider.parseCodexResponse('   \n\t\n  ', 1);
        expect(result.success).toBe(false);
      });

      it('should skip non-agent_message items', () => {
        const stdout = [
          '{"type": "item.completed", "item": {"type": "reasoning", "text": "thinking about it..."}}',
          '{"type": "item.completed", "item": {"type": "tool_call", "name": "read"}}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"answer\\": 42}"}}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ answer: 42 });
      });

      it('should handle item.completed without item property', () => {
        const stdout = [
          '{"type": "item.completed"}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"ok\\": true}"}}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ ok: true });
      });

      it('should handle agent_message without text property', () => {
        const stdout = [
          '{"type": "item.completed", "item": {"type": "agent_message"}}',
          '{"type": "item.completed", "item": {"type": "agent_message", "text": "{\\"found\\": true}"}}'
        ].join('\n');

        const result = provider.parseCodexResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ found: true });
      });
    });
  });

  describe('buildArgsForModel', () => {
    it('should resolve cli_model for gpt-5.4-high variant', () => {
      // Reasoning variants pass the base model to `-m` and add effort via
      // `-c model_reasoning_effort="..."`, with the stdin marker `-` last.
      const provider = new CodexProvider('gpt-5.4-mini');
      const args = provider.buildArgsForModel('gpt-5.4-high');
      const mIdx = args.indexOf('-m');
      expect(mIdx).toBeGreaterThanOrEqual(0);
      expect(args[mIdx + 1]).toBe('gpt-5.4');
      const effortIdx = args.indexOf('model_reasoning_effort="high"');
      expect(effortIdx).toBeGreaterThanOrEqual(1);
      expect(args[effortIdx - 1]).toBe('-c');
      expect(args[args.length - 1]).toBe('-');
    });

    it('should resolve legacy `gpt-5.4` alias to the high-effort variant shape', () => {
      // Alias keeps historical analysis runs recorded under bare `gpt-5.4`
      // executable against the canonical gpt-5.4-high configuration.
      const provider = new CodexProvider('gpt-5.4-mini');
      const args = provider.buildArgsForModel('gpt-5.4');
      const mIdx = args.indexOf('-m');
      expect(args[mIdx + 1]).toBe('gpt-5.4');
      expect(args).toContain('model_reasoning_effort="high"');
      expect(args[args.length - 1]).toBe('-');
    });

    it('should use read-only sandbox for extraction (distinct from workspace-write)', () => {
      const provider = new CodexProvider('gpt-5.4-mini');
      const args = provider.buildArgsForModel('gpt-5.4-mini');
      const sandboxIdx = args.indexOf('--sandbox');
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(args[sandboxIdx + 1]).toBe('read-only');
      expect(args).toContain('--full-auto');
      // Extraction must not inherit the constructor's workspace-write mode
      expect(args).not.toContain('workspace-write');
    });

    it('should respect config cli_model override (config > built-in > modelId)', () => {
      // Documents the precedence chain in _resolveModelConfig: a per-model
      // config `cli_model` beats the built-in `cli_model` (which is
      // `gpt-5.4` for the high variant).
      const provider = new CodexProvider('gpt-5.4-high', {
        models: [
          { id: 'gpt-5.4-high', cli_model: 'custom-model' }
        ]
      });
      const args = provider.buildArgsForModel('gpt-5.4-high');
      const mIdx = args.indexOf('-m');
      expect(mIdx).toBeGreaterThanOrEqual(0);
      expect(args[mIdx + 1]).toBe('custom-model');
      expect(args).not.toContain('gpt-5.4');
    });

    it('should NOT add reasoning effort args for bare gpt-5.5 (no alias by design)', () => {
      // Intentional: `gpt-5.5-high` deliberately has no `aliases: ['gpt-5.5']`
      // because gpt-5.5 is brand new — there is no legacy data recorded under
      // the bare model ID to preserve. Adding an alias later would silently
      // change the meaning of `gpt-5.5` for any consumer that stored it.
      const provider = new CodexProvider('gpt-5.4-mini');
      const args = provider.buildArgsForModel('gpt-5.5');
      const effortArg = args.find(a => typeof a === 'string' && a.startsWith('model_reasoning_effort='));
      expect(effortArg).toBeUndefined();
    });
  });

  describe('getExtractionConfig', () => {
    it('should return correct config for default command', () => {
      const provider = new CodexProvider();
      const config = provider.getExtractionConfig('gpt-5.4-nano');

      expect(config.command).toBe('codex');
      expect(config.args).toContain('exec');
      expect(config.args).toContain('-m');
      expect(config.args).toContain('gpt-5.4-nano');
      expect(config.args).toContain('--sandbox');
      expect(config.args).toContain('read-only');
      expect(config.useShell).toBe(false);
      expect(config.promptViaStdin).toBe(true);
    });

    it('should use shell mode for multi-word command', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = 'docker run codex';
      const provider = new CodexProvider();
      const config = provider.getExtractionConfig('gpt-5.4-nano');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('docker run codex');
      expect(config.args).toEqual([]);
    });

    it('should include merged env in return value (matches provider contract)', () => {
      // env is merged built-in → provider → per-model. Extraction spawn
      // must receive it so reasoning/env-driven variants (claude-style
      // effort envs, user config env, etc.) take effect.
      const provider = new CodexProvider('gpt-5.4-mini', {
        env: { PROVIDER_VAR: 'p' },
        models: [
          { id: 'gpt-5.4-nano', env: { MODEL_VAR: 'm' } }
        ]
      });
      const config = provider.getExtractionConfig('gpt-5.4-nano');
      expect(config.env).toEqual({ PROVIDER_VAR: 'p', MODEL_VAR: 'm' });
    });

    it('should include env in shell-mode return value', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = 'docker run codex';
      const provider = new CodexProvider('gpt-5.4-mini', {
        env: { FROM_PROVIDER: '1' }
      });
      const config = provider.getExtractionConfig('gpt-5.4-nano');
      expect(config.useShell).toBe(true);
      expect(config.env).toEqual({ FROM_PROVIDER: '1' });
    });
  });

  describe('logStreamLine', () => {
    let provider;
    const logger = require('../../src/utils/logger');

    beforeEach(() => {
      provider = new CodexProvider('gpt-5.4-mini');
      vi.clearAllMocks();
    });

    afterEach(() => {
      // Ensure stream debug is disabled after tests
      logger.setStreamDebugEnabled(false);
    });

    // Note: These tests verify logStreamLine doesn't throw and handles various event types.
    // The mock uses the real isStreamDebugEnabled/setStreamDebugEnabled for state tracking.
    // We verify behavior by checking that no errors are thrown.

    it('should not throw when stream debug is disabled', () => {
      logger.setStreamDebugEnabled(false);
      const line = '{"type": "thread.started", "thread_id": "abc123"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should not throw when stream debug is enabled', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "thread.started", "thread_id": "abc123"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle thread.started events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "thread.started", "thread_id": "abc123456789"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle turn.started events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "turn.started", "turn_id": "turn123"}';
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle agent_message events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "item.completed", "item": {"type": "agent_message", "text": "This is a test message"}}';
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle long agent_message text without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const longText = 'A'.repeat(100);
      const line = `{"type": "item.completed", "item": {"type": "agent_message", "text": "${longText}"}}`;
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle empty agent_message without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "item.completed", "item": {"type": "agent_message", "text": ""}}';
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle function_call events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'item.completed',
        item: {
          type: 'function_call',
          name: 'run_shell',
          id: 'call_12345678',
          arguments: JSON.stringify({ command: 'git diff HEAD~1' })
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 4, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_call events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'item.completed',
        item: {
          type: 'tool_call',
          name: 'read_file',
          input: { file_path: '/path/to/file.js' }
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 5, '[Level 1]')).not.toThrow();
    });

    it('should handle function_call_output events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'item.completed',
        item: {
          type: 'function_call_output',
          call_id: 'call_12345678',
          output: 'File contents here'
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_result with error flag without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'item.completed',
        item: {
          type: 'function_call_output',
          is_error: true,
          output: 'Command failed'
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 5, '[Level 1]')).not.toThrow();
    });

    it('should handle reasoning events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'item.completed',
        item: {
          type: 'reasoning',
          summary: 'Analyzing the code structure'
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 6, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown item types without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'item.completed',
        item: {
          type: 'new_future_type'
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 7, '[Level 1]')).not.toThrow();
    });

    it('should handle turn.completed events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "turn.completed", "usage": {"input_tokens": 500, "output_tokens": 200, "total_tokens": 700}}';
      expect(() => provider.logStreamLine(line, 10, '[Level 1]')).not.toThrow();
    });

    it('should handle turn.completed with alternate token field names', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "turn.completed", "usage": {"prompt_tokens": 100, "completion_tokens": 50}}';
      expect(() => provider.logStreamLine(line, 10, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown event types without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "some_new_event_type"}';
      expect(() => provider.logStreamLine(line, 8, '[Level 1]')).not.toThrow();
    });

    it('should handle malformed JSON gracefully without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('not valid json {', 9, '[Level 1]')).not.toThrow();
    });

    it('should handle empty line without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('', 1, '[Level 1]')).not.toThrow();
    });

    it('should handle item.completed without item property without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "item.completed"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle agent_message without text property without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "item.completed", "item": {"type": "agent_message"}}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('codex');
      expect(RegisteredProvider).toBe(CodexProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('codex');
    });
  });
});
