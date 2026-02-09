// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for ClaudeProvider
 *
 * These tests focus on static methods, constructor behavior, response parsing,
 * and streaming line logging without requiring actual CLI processes.
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
const ClaudeProvider = require('../../src/ai/claude-provider');
const logger = require('../../src/utils/logger');

describe('ClaudeProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_CLAUDE_CMD;
    delete process.env.PAIR_REVIEW_MAX_BUDGET_USD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(ClaudeProvider.getProviderName()).toBe('Claude');
    });

    it('should return correct provider ID', () => {
      expect(ClaudeProvider.getProviderId()).toBe('claude');
    });

    it('should return opus as default model', () => {
      expect(ClaudeProvider.getDefaultModel()).toBe('opus');
    });

    it('should return array of models with expected structure', () => {
      const models = ClaudeProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(7);

      // Check that we have haiku, sonnet, and opus variants
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('haiku');
      expect(modelIds).toContain('sonnet');
      expect(modelIds).toContain('opus-4.5');
      expect(modelIds).toContain('opus-4.6-low');
      expect(modelIds).toContain('opus-4.6-medium');
      expect(modelIds).toContain('opus');
      expect(modelIds).toContain('opus-4.6-1m');

      // Check model structure - opus is now the default
      const opus = models.find(m => m.id === 'opus');
      expect(opus).toMatchObject({
        id: 'opus',
        name: 'Opus 4.6 High',
        tier: 'thorough',
        default: true
      });

      // sonnet should NOT have default: true anymore
      const sonnet = models.find(m => m.id === 'sonnet');
      expect(sonnet.default).toBeUndefined();

      // Check opus variants have correct tiers
      for (const id of ['opus-4.5', 'opus-4.6-low', 'opus-4.6-medium', 'opus-4.6-1m']) {
        const model = models.find(m => m.id === id);
        expect(model.tier).toBe('balanced');
      }
      // opus itself is thorough
      expect(opus.tier).toBe('thorough');
    });

    it('should return install instructions', () => {
      const instructions = ClaudeProvider.getInstallInstructions();
      expect(instructions).toContain('claude-code');
      expect(instructions).toContain('npm');
    });
  });

  describe('constructor', () => {
    it('should create instance with default model', () => {
      const provider = new ClaudeProvider();
      expect(provider.model).toBe('opus');
    });

    it('should create instance with specified model', () => {
      const provider = new ClaudeProvider('opus');
      expect(provider.model).toBe('opus');
    });

    it('should use default claude command', () => {
      const provider = new ClaudeProvider('sonnet');
      expect(provider.command).toBe('claude');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_CLAUDE_CMD environment variable', () => {
      process.env.PAIR_REVIEW_CLAUDE_CMD = '/custom/claude';
      const provider = new ClaudeProvider('sonnet');
      expect(provider.command).toBe('/custom/claude');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_CLAUDE_CMD = 'devx claude';
      const provider = new ClaudeProvider('sonnet');
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain('devx claude');
    });

    it('should configure base args correctly', () => {
      const provider = new ClaudeProvider('haiku');
      expect(provider.args).toContain('-p');
      expect(provider.args).toContain('--verbose');
      expect(provider.args).toContain('--model');
      expect(provider.args).toContain('haiku');
      expect(provider.args).toContain('--output-format');
      expect(provider.args).toContain('stream-json');
      expect(provider.args).toContain('--allowedTools');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new ClaudeProvider('sonnet', {
        extra_args: ['--custom-flag', '--timeout', '60']
      });
      expect(provider.args).toContain('--custom-flag');
      expect(provider.args).toContain('--timeout');
      expect(provider.args).toContain('60');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new ClaudeProvider('opus', {
        models: [
          { id: 'opus', extra_args: ['--special-flag'] }
        ]
      });
      expect(provider.args).toContain('--special-flag');
    });

    it('should use config command over default', () => {
      const provider = new ClaudeProvider('sonnet', {
        command: '/path/to/claude'
      });
      expect(provider.command).toBe('/path/to/claude');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_CLAUDE_CMD = '/env/claude';
      const provider = new ClaudeProvider('sonnet', {
        command: '/config/claude'
      });
      expect(provider.command).toBe('/env/claude');
    });

    it('should merge env from provider config', () => {
      const provider = new ClaudeProvider('sonnet', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new ClaudeProvider('opus', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'opus', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    describe('yolo mode', () => {
      it('should use --allowedTools and not --dangerously-skip-permissions by default', () => {
        const provider = new ClaudeProvider('sonnet');
        expect(provider.args).toContain('--allowedTools');
        expect(provider.args).not.toContain('--dangerously-skip-permissions');
      });

      it('should use --dangerously-skip-permissions and not --allowedTools when yolo is true', () => {
        const provider = new ClaudeProvider('sonnet', { yolo: true });
        expect(provider.args).toContain('--dangerously-skip-permissions');
        expect(provider.args).not.toContain('--allowedTools');
      });

      it('should use --allowedTools and not --dangerously-skip-permissions when yolo is false', () => {
        const provider = new ClaudeProvider('sonnet', { yolo: false });
        expect(provider.args).toContain('--allowedTools');
        expect(provider.args).not.toContain('--dangerously-skip-permissions');
      });
    });

    describe('cli_model resolution', () => {
      it('should resolve cli_model from built-in model definition', () => {
        // opus-4.6-low has cli_model: 'opus' in built-in definition
        const provider = new ClaudeProvider('opus-4.6-low');
        const modelIdx = provider.args.indexOf('--model');
        expect(modelIdx).not.toBe(-1);
        expect(provider.args[modelIdx + 1]).toBe('opus');
      });

      it('should fall back to id when no cli_model is defined', () => {
        // sonnet has no cli_model in built-in definition
        const provider = new ClaudeProvider('sonnet');
        const modelIdx = provider.args.indexOf('--model');
        expect(modelIdx).not.toBe(-1);
        expect(provider.args[modelIdx + 1]).toBe('sonnet');
      });

      it('should use config cli_model over built-in cli_model', () => {
        const provider = new ClaudeProvider('opus-4.6-low', {
          models: [
            { id: 'opus-4.6-low', cli_model: 'custom-opus' }
          ]
        });
        const modelIdx = provider.args.indexOf('--model');
        expect(modelIdx).not.toBe(-1);
        expect(provider.args[modelIdx + 1]).toBe('custom-opus');
      });

      it('should suppress --model entirely when cli_model is null', () => {
        const provider = new ClaudeProvider('opus-4.6-low', {
          models: [
            { id: 'opus-4.6-low', cli_model: null }
          ]
        });
        expect(provider.args).not.toContain('--model');
      });

      it('should NOT suppress --model when cli_model is empty string', () => {
        const provider = new ClaudeProvider('opus-4.6-low', {
          models: [
            { id: 'opus-4.6-low', cli_model: '' }
          ]
        });
        const modelIdx = provider.args.indexOf('--model');
        expect(modelIdx).not.toBe(-1);
        expect(provider.args[modelIdx + 1]).toBe('');
      });

      it('should resolve opus-4.5 to its full version cli_model', () => {
        const provider = new ClaudeProvider('opus-4.5');
        const modelIdx = provider.args.indexOf('--model');
        expect(modelIdx).not.toBe(-1);
        expect(provider.args[modelIdx + 1]).toBe('claude-opus-4-5-20251101');
      });

      it('should resolve opus-4.6-1m to opus[1m] cli_model', () => {
        const provider = new ClaudeProvider('opus-4.6-1m');
        const modelIdx = provider.args.indexOf('--model');
        expect(modelIdx).not.toBe(-1);
        expect(provider.args[modelIdx + 1]).toBe('opus[1m]');
      });
    });

    describe('alias resolution', () => {
      it('should resolve opus-4.6-high alias to opus model', () => {
        const provider = new ClaudeProvider('opus-4.6-high');
        expect(provider.model).toBe('opus-4.6-high');
        expect(provider.extraEnv).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
      });

      it('should resolve opus-4.6-high alias in _resolveModelConfig', () => {
        const provider = new ClaudeProvider('opus');
        const resolved = provider._resolveModelConfig('opus-4.6-high');
        expect(resolved.builtIn).toBeDefined();
        expect(resolved.builtIn.id).toBe('opus');
        expect(resolved.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
      });

      it('should resolve opus-4.6-high alias in getExtractionConfig', () => {
        const provider = new ClaudeProvider('sonnet');
        const config = provider.getExtractionConfig('opus-4.6-high');
        expect(config.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
      });
    });

    describe('built-in env', () => {
      it('should include built-in env for opus (high effort)', () => {
        const provider = new ClaudeProvider('opus');
        expect(provider.extraEnv).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
      });

      it('should include built-in env for opus-4.6-low', () => {
        const provider = new ClaudeProvider('opus-4.6-low');
        expect(provider.extraEnv).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'low' });
      });

      it('should include built-in env for opus-4.6-medium', () => {
        const provider = new ClaudeProvider('opus-4.6-medium');
        expect(provider.extraEnv).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'medium' });
      });

      it('should have empty extraEnv for models without built-in env', () => {
        const provider = new ClaudeProvider('sonnet');
        expect(provider.extraEnv).toEqual({});
      });

      it('should have empty extraEnv for opus-4.5 (no built-in env)', () => {
        const provider = new ClaudeProvider('opus-4.5');
        expect(provider.extraEnv).toEqual({});
      });
    });

    describe('three-way env merge', () => {
      it('should merge built-in, provider, and config model env in correct order', () => {
        const provider = new ClaudeProvider('opus', {
          env: { PROVIDER_VAR: 'from-provider', CLAUDE_CODE_EFFORT_LEVEL: 'provider-override' },
          models: [
            { id: 'opus', env: { MODEL_VAR: 'from-model', CLAUDE_CODE_EFFORT_LEVEL: 'model-override' } }
          ]
        });
        // Config model env wins over provider env, which wins over built-in env
        expect(provider.extraEnv.CLAUDE_CODE_EFFORT_LEVEL).toBe('model-override');
        expect(provider.extraEnv.PROVIDER_VAR).toBe('from-provider');
        expect(provider.extraEnv.MODEL_VAR).toBe('from-model');
      });

      it('should let provider env override built-in env when no config model env', () => {
        const provider = new ClaudeProvider('opus', {
          env: { CLAUDE_CODE_EFFORT_LEVEL: 'provider-override' }
        });
        expect(provider.extraEnv.CLAUDE_CODE_EFFORT_LEVEL).toBe('provider-override');
      });
    });

    describe('three-way extra_args merge', () => {
      it('should include built-in extra_args in the args array', () => {
        // Models with built-in extra_args would include them in args
        // Currently none of the built-in models have extra_args, so test with config override
        const provider = new ClaudeProvider('sonnet', {
          extra_args: ['--provider-arg'],
          models: [
            { id: 'sonnet', extra_args: ['--model-arg'] }
          ]
        });
        expect(provider.args).toContain('--provider-arg');
        expect(provider.args).toContain('--model-arg');
      });
    });
  });

  describe('PAIR_REVIEW_MAX_BUDGET_USD validation', () => {
    let warnSpy;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn');
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('should pass valid positive number through to args', () => {
      process.env.PAIR_REVIEW_MAX_BUDGET_USD = '2';
      const provider = new ClaudeProvider('sonnet');
      const budgetIdx = provider.args.indexOf('--max-budget-usd');
      expect(budgetIdx).not.toBe(-1);
      expect(provider.args[budgetIdx + 1]).toBe('2');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD')
      );
    });

    it('should pass decimal budget values through to args', () => {
      process.env.PAIR_REVIEW_MAX_BUDGET_USD = '0.5';
      const provider = new ClaudeProvider('sonnet');
      const budgetIdx = provider.args.indexOf('--max-budget-usd');
      expect(budgetIdx).not.toBe(-1);
      expect(provider.args[budgetIdx + 1]).toBe('0.5');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD')
      );
    });

    it('should ignore invalid string "abc" with a warning', () => {
      process.env.PAIR_REVIEW_MAX_BUDGET_USD = 'abc';
      const provider = new ClaudeProvider('sonnet');
      expect(provider.args).not.toContain('--max-budget-usd');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD="abc"')
      );
    });

    it('should ignore empty string (falsy, does not enter if block)', () => {
      process.env.PAIR_REVIEW_MAX_BUDGET_USD = '';
      const provider = new ClaudeProvider('sonnet');
      expect(provider.args).not.toContain('--max-budget-usd');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD')
      );
    });

    it('should ignore negative number "-1" with a warning', () => {
      process.env.PAIR_REVIEW_MAX_BUDGET_USD = '-1';
      const provider = new ClaudeProvider('sonnet');
      expect(provider.args).not.toContain('--max-budget-usd');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD="-1"')
      );
    });

    it('should ignore zero "0" with a warning', () => {
      process.env.PAIR_REVIEW_MAX_BUDGET_USD = '0';
      const provider = new ClaudeProvider('sonnet');
      expect(provider.args).not.toContain('--max-budget-usd');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD="0"')
      );
    });

    it('should not include budget args when env var is not set', () => {
      delete process.env.PAIR_REVIEW_MAX_BUDGET_USD;
      const provider = new ClaudeProvider('sonnet');
      expect(provider.args).not.toContain('--max-budget-usd');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('PAIR_REVIEW_MAX_BUDGET_USD')
      );
    });
  });

  describe('parseClaudeResponse', () => {
    let provider;

    beforeEach(() => {
      provider = new ClaudeProvider('sonnet');
    });

    describe('single-source text extraction', () => {
      it('should extract text from result.content when no subresult exists', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: '{"findings": []}' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ findings: [] });
      });

      it('should handle result with empty content array', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: []
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No text content');
      });

      it('should handle result with multiple content blocks', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: '{"part1":' },
              { type: 'text', text: ' "value", "part2": 42}' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ part1: 'value', part2: 42 });
      });

      it('should skip non-text content blocks', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'image', data: 'base64...' },
              { type: 'text', text: '{"valid": true}' },
              { type: 'tool_use', name: 'some_tool' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ valid: true });
      });
    });

    describe('subresult early-return path', () => {
      it('should return subresult directly when it is an object', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            subresult: { structured: 'data', count: 5 },
            content: [
              { type: 'text', text: '{"should_be_ignored": true}' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ structured: 'data', count: 5 });
      });

      it('should ignore text content when subresult exists', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            subresult: { priority: 'high' },
            content: [
              { type: 'text', text: '{"priority": "low"}' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data.priority).toBe('high');
      });

      it('should handle subresult with complex nested structure', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            subresult: {
              suggestions: [
                { file: 'a.js', line: 10, message: 'Issue found' }
              ],
              metadata: { version: '1.0' }
            }
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data.suggestions).toHaveLength(1);
        expect(result.data.suggestions[0].file).toBe('a.js');
      });

      it('should not use subresult if it is not an object', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            subresult: 'just a string',
            content: [
              { type: 'text', text: '{"fallback": true}' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ fallback: true });
      });
    });

    describe('malformed JSONL handling', () => {
      it('should skip invalid JSON lines gracefully', () => {
        const stdout = [
          '{"type": "system", "message": "Starting..."}',
          'not valid json at all',
          '{"type": "result", "result": {"content": [{"type": "text", "text": "{\\"valid\\": true}"}]}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ valid: true });
      });

      it('should handle empty lines', () => {
        const stdout = [
          '',
          '{"type": "system"}',
          '',
          '{"type": "result", "result": {"content": [{"type": "text", "text": "{\\"data\\": 123}"}]}}',
          ''
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ data: 123 });
      });

      it('should handle mixed valid and invalid lines', () => {
        const stdout = [
          '{truncated',
          '{"type": "assistant", "message": {}}',
          'random garbage',
          '{"type": "result", "result": {"content": [{"type": "text", "text": "{\\"items\\": [1,2,3]}"}]}}',
          '{ also broken }'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ items: [1, 2, 3] });
      });

      it('should handle completely malformed input by trying extractJSON', () => {
        // This triggers the outer catch block that falls back to extractJSON
        const stdout = '{"broken json';

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('JSON extraction from accumulated text', () => {
      it('should extract JSON object from text content', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: 'Here is the result: {"key": "value"}' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ key: 'value' });
      });

      it('should extract full JSON array from array-like text content', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: '[{"id": 1}, {"id": 2}]' }
            ]
          }
        });

        // extractJSON parses the full valid JSON — when the text IS a JSON array,
        // the direct-parse strategy succeeds and returns the complete array.
        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
      });

      it('should handle text with no JSON', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: 'Just plain text with no JSON structure at all.' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('not valid JSON');
      });

      it('should handle text with markdown code blocks containing JSON', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: '```json\n{"wrapped": true, "count": 42}\n```' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ wrapped: true, count: 42 });
      });

      it('should extract JSON from text with surrounding explanation', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: 'I analyzed the code and found:\n{"findings": ["issue1", "issue2"]}\nPlease review.' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data.findings).toEqual(['issue1', 'issue2']);
      });
    });

    describe('edge cases', () => {
      it('should handle empty response string', () => {
        const result = provider.parseClaudeResponse('', 1);
        expect(result.success).toBe(false);
      });

      it('should handle whitespace-only response', () => {
        const result = provider.parseClaudeResponse('   \n\t\n  ', 1);
        expect(result.success).toBe(false);
      });

      it('should handle response with only non-result events', () => {
        const stdout = [
          '{"type": "system", "data": "init"}',
          '{"type": "assistant", "message": {}}',
          '{"type": "user", "message": {}}',
          '{"type": "stream_event", "event": {}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('No text content');
      });

      it('should return error object when no text content found', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'image', data: 'binary' }
            ]
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it('should handle result with null content', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: null
          }
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
      });

      it('should handle result with missing result property', () => {
        const stdout = JSON.stringify({
          type: 'result'
        });

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(false);
      });

      it('should use first result event found', () => {
        const stdout = [
          '{"type": "system"}',
          '{"type": "result", "result": {"content": [{"type": "text", "text": "{\\"first\\": true}"}]}}',
          '{"type": "result", "result": {"content": [{"type": "text", "text": "{\\"second\\": true}"}]}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ first: true });
      });

      it('should fall back to assistant text when result has no text content', () => {
        // This tests the scenario where Claude uses tools and the JSON response
        // is in assistant events, not in the result event
        const stdout = [
          '{"type": "system"}',
          '{"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read"}]}}',
          '{"type": "user", "message": {"content": [{"type": "tool_result", "content": "file contents"}]}}',
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "{\\"suggestions\\": [{\\"id\\": 1}]}"}]}}',
          '{"type": "result", "result": {"subresult": null, "content": []}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ suggestions: [{ id: 1 }] });
      });

      it('should prefer result.content over assistant text when both present', () => {
        const stdout = [
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "{\\"from\\": \\"assistant\\"}"}]}}',
          '{"type": "result", "result": {"content": [{"type": "text", "text": "{\\"from\\": \\"result\\"}"}]}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ from: 'result' });
      });

      it('should discard text before tool_use and only keep text after last tool interaction', () => {
        // This tests the multi-turn tool usage scenario where earlier assistant messages
        // contain reasoning/partial responses that should NOT be included in the final output.
        // The text "Let me think..." is discarded when tool_use is encountered,
        // and only the JSON after the tool result is captured.
        const stdout = [
          '{"type": "system"}',
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "Let me think about this..."}, {"type": "tool_use", "name": "Read", "id": "tool1"}]}}',
          '{"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tool1", "content": "file contents"}]}}',
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "{\\"suggestions\\": [{\\"id\\": 1}]}"}]}}',
          '{"type": "result", "result": {"subresult": null, "content": []}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        // Should only have the JSON, not "Let me think about this...{\"suggestions\": ...}"
        expect(result.data).toEqual({ suggestions: [{ id: 1 }] });
      });

      it('should discard text from multiple tool turns and only keep final response', () => {
        // Test with multiple tool usage rounds - only the last assistant text should be kept
        const stdout = [
          '{"type": "system"}',
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "First I will read file A..."}, {"type": "tool_use", "name": "Read", "id": "tool1"}]}}',
          '{"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tool1", "content": "contents of A"}]}}',
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "Now I will read file B..."}, {"type": "tool_use", "name": "Read", "id": "tool2"}]}}',
          '{"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tool2", "content": "contents of B"}]}}',
          '{"type": "assistant", "message": {"content": [{"type": "text", "text": "{\\"final\\": \\"response\\"}"}]}}',
          '{"type": "result", "result": {"subresult": null, "content": []}}'
        ].join('\n');

        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        // Should only have the final JSON, not accumulated text from earlier turns
        expect(result.data).toEqual({ final: 'response' });
      });
    });
  });

  describe('logStreamLine', () => {
    let provider;

    beforeEach(() => {
      provider = new ClaudeProvider('sonnet');
      // Reset stream debug state before each test
      logger.setStreamDebugEnabled(false);
    });

    afterEach(() => {
      // Ensure stream debug is disabled after tests
      logger.setStreamDebugEnabled(false);
    });

    // These tests verify logStreamLine doesn't throw and handles various event types

    it('should not throw when stream debug is disabled', () => {
      logger.setStreamDebugEnabled(false);
      const line = JSON.stringify({
        type: 'stream_event',
        event: { delta: { type: 'text_delta', text: 'test' } }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle stream_event with text_delta without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          delta: { type: 'text_delta', text: 'Some streaming text' }
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle stream_event without delta without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'stream_event',
        event: {}
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant events with tool_use without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'read_file',
            id: 'toolu_abc123',
            input: { file_path: '/path/to/file.js' }
          }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant events with command tool_use without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'bash',
            id: 'toolu_xyz789',
            input: { command: 'git status' }
          }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle user events (tool results) without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', result: 'data' }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle user events with tool_result including error without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_abc123',
            is_error: true,
            content: 'File not found'
          }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle user events with tool_result content array without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_abc123',
            content: [{ type: 'text', text: 'File contents here' }]
          }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle result events without throwing', () => {
      const line = JSON.stringify({
        type: 'result',
        cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 50 },
        result: {
          content: [{ type: 'text', text: '{"data": true}' }]
        }
      });
      // Result events always log to info (not affected by stream debug)
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle result events without cost info without throwing', () => {
      const line = JSON.stringify({
        type: 'result',
        result: {
          content: [{ type: 'text', text: 'response' }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle system events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'system',
        data: 'initialization complete'
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown event types without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'custom_type',
        data: 'something'
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle malformed JSON gracefully without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('not json', '[Level 1]')).not.toThrow();
    });

    it('should handle empty line without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('', '[Level 1]')).not.toThrow();
    });

    it('should handle event with no type without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ data: 'no type field' });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle long text in stream_event without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const longText = 'A'.repeat(200);
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          delta: { type: 'text_delta', text: longText }
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle text with newlines without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          delta: { type: 'text_delta', text: 'Line1\nLine2\nLine3' }
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });
  });

  describe('buildArgsForModel', () => {
    it('should resolve cli_model for opus-4.5', () => {
      const provider = new ClaudeProvider('sonnet');
      const args = provider.buildArgsForModel('opus-4.5');
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('claude-opus-4-5-20251101');
    });

    it('should resolve cli_model for opus-4.6-low', () => {
      const provider = new ClaudeProvider('sonnet');
      const args = provider.buildArgsForModel('opus-4.6-low');
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('opus');
    });

    it('should fall back to id when no cli_model defined', () => {
      const provider = new ClaudeProvider('sonnet');
      const args = provider.buildArgsForModel('haiku');
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('haiku');
    });

    it('should suppress --model when config cli_model is null', () => {
      const provider = new ClaudeProvider('sonnet', {
        models: [
          { id: 'sonnet', cli_model: null }
        ]
      });
      const args = provider.buildArgsForModel('sonnet');
      expect(args).not.toContain('--model');
    });

    it('should NOT suppress --model when config cli_model is empty string', () => {
      const provider = new ClaudeProvider('sonnet', {
        models: [
          { id: 'sonnet', cli_model: '' }
        ]
      });
      const args = provider.buildArgsForModel('sonnet');
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).not.toBe(-1);
      expect(args[modelIdx + 1]).toBe('');
    });

    it('should include provider and config model extra_args', () => {
      const provider = new ClaudeProvider('sonnet', {
        extra_args: ['--provider-flag'],
        models: [
          { id: 'haiku', extra_args: ['--haiku-flag'] }
        ]
      });
      const args = provider.buildArgsForModel('haiku');
      expect(args).toContain('--provider-flag');
      expect(args).toContain('--haiku-flag');
    });
  });

  describe('getExtractionConfig', () => {
    it('should return env from built-in model definition', () => {
      const provider = new ClaudeProvider('sonnet');
      const config = provider.getExtractionConfig('opus');
      expect(config.env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    });

    it('should return empty env for models without built-in env', () => {
      const provider = new ClaudeProvider('sonnet');
      const config = provider.getExtractionConfig('haiku');
      expect(config.env).toEqual({});
    });

    it('should three-way merge env in extraction config', () => {
      const provider = new ClaudeProvider('sonnet', {
        env: { PROVIDER_VAR: 'yes' },
        models: [
          { id: 'opus', env: { MODEL_VAR: 'yes' } }
        ]
      });
      const config = provider.getExtractionConfig('opus');
      // Built-in + provider + config model
      expect(config.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high'); // built-in, not overridden
      expect(config.env.PROVIDER_VAR).toBe('yes');
      expect(config.env.MODEL_VAR).toBe('yes');
    });

    it('should resolve cli_model in extraction args', () => {
      const provider = new ClaudeProvider('sonnet');
      const config = provider.getExtractionConfig('opus-4.5');
      expect(config.args).toContain('--model');
      const modelIdx = config.args.indexOf('--model');
      expect(config.args[modelIdx + 1]).toBe('claude-opus-4-5-20251101');
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('claude');
      expect(RegisteredProvider).toBe(ClaudeProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('claude');
    });
  });
});
