// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for ClaudeProvider
 *
 * These tests focus on static methods, constructor behavior, response parsing,
 * and streaming line logging without requiring actual CLI processes.
 */

// Mock logger to suppress output during tests
vi.mock('../../src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn()
  }
}));

// Import after mocks are set up
const ClaudeProvider = require('../../src/ai/claude-provider');

describe('ClaudeProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_CLAUDE_CMD;
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

    it('should return sonnet as default model', () => {
      expect(ClaudeProvider.getDefaultModel()).toBe('sonnet');
    });

    it('should return array of models with expected structure', () => {
      const models = ClaudeProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(3);

      // Check that we have haiku, sonnet, opus
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('haiku');
      expect(modelIds).toContain('sonnet');
      expect(modelIds).toContain('opus');

      // Check model structure
      const sonnet = models.find(m => m.id === 'sonnet');
      expect(sonnet).toMatchObject({
        id: 'sonnet',
        name: 'Sonnet',
        tier: 'balanced',
        default: true
      });
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
      expect(provider.model).toBe('sonnet');
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

      it('should extract first JSON object from array-like text content', () => {
        const stdout = JSON.stringify({
          type: 'result',
          result: {
            content: [
              { type: 'text', text: '[{"id": 1}, {"id": 2}]' }
            ]
          }
        });

        // extractJSON strategy 2 extracts from first { to last }, so from an array
        // it will extract only the first object. This documents current behavior.
        const result = provider.parseClaudeResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ id: 1 });
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
    });
  });

  describe('logStreamLine', () => {
    let provider;

    beforeEach(() => {
      provider = new ClaudeProvider('sonnet');
    });

    // These tests verify logStreamLine doesn't throw and handles various event types

    it('should handle stream_event with text_delta without throwing', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          delta: { type: 'text_delta', text: 'Some streaming text' }
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle stream_event without delta without throwing', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {}
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant events without throwing', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }]
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle user events (tool results) without throwing', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', result: 'data' }]
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
      const line = JSON.stringify({
        type: 'system',
        data: 'initialization complete'
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown event types without throwing', () => {
      const line = JSON.stringify({
        type: 'custom_type',
        data: 'something'
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle malformed JSON gracefully without throwing', () => {
      expect(() => provider.logStreamLine('not json', '[Level 1]')).not.toThrow();
    });

    it('should handle empty line without throwing', () => {
      expect(() => provider.logStreamLine('', '[Level 1]')).not.toThrow();
    });

    it('should handle event with no type without throwing', () => {
      const line = JSON.stringify({ data: 'no type field' });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
    });

    it('should handle long text in stream_event without throwing', () => {
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
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          delta: { type: 'text_delta', text: 'Line1\nLine2\nLine3' }
        }
      });
      expect(() => provider.logStreamLine(line, '[Level 1]')).not.toThrow();
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
