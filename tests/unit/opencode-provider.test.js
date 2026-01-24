// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for OpenCodeProvider
 *
 * These tests focus on static methods, constructor behavior, response parsing,
 * and streaming line logging without requiring actual CLI processes.
 */

// Mock logger to suppress output during tests
// Use actual implementation for state tracking, but mock output methods
vi.mock('../../src/utils/logger', () => {
  let streamDebugEnabled = false;
  return {
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      debug: vi.fn(),
      streamDebug: vi.fn(),
      isStreamDebugEnabled: () => streamDebugEnabled,
      setStreamDebugEnabled: (enabled) => { streamDebugEnabled = enabled; }
    }
  };
});

// Import after mocks are set up
const OpenCodeProvider = require('../../src/ai/opencode-provider');

describe('OpenCodeProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_OPENCODE_CMD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(OpenCodeProvider.getProviderName()).toBe('OpenCode');
    });

    it('should return correct provider ID', () => {
      expect(OpenCodeProvider.getProviderId()).toBe('opencode');
    });

    it('should return null as default model (requires config)', () => {
      expect(OpenCodeProvider.getDefaultModel()).toBe(null);
    });

    it('should return empty models array (requires config)', () => {
      const models = OpenCodeProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models).toHaveLength(0);
    });

    it('should return install instructions with opencode.ai', () => {
      const instructions = OpenCodeProvider.getInstallInstructions();
      expect(instructions).toContain('opencode.ai');
      expect(instructions).toContain('curl');
    });
  });

  describe('constructor', () => {
    it('should throw error when no model provided', () => {
      expect(() => new OpenCodeProvider()).toThrow('OpenCode requires a model');
    });

    it('should throw error with null model', () => {
      expect(() => new OpenCodeProvider(null)).toThrow('OpenCode requires a model');
    });

    it('should create instance with specified model', () => {
      const provider = new OpenCodeProvider('anthropic/claude-sonnet-4');
      expect(provider.model).toBe('anthropic/claude-sonnet-4');
    });

    it('should use default opencode command', () => {
      const provider = new OpenCodeProvider('test-model');
      expect(provider.opencodeCmd).toBe('opencode');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_OPENCODE_CMD environment variable', () => {
      process.env.PAIR_REVIEW_OPENCODE_CMD = '/custom/opencode';
      const provider = new OpenCodeProvider('test-model');
      expect(provider.opencodeCmd).toBe('/custom/opencode');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_OPENCODE_CMD = 'npx opencode';
      const provider = new OpenCodeProvider('test-model');
      expect(provider.opencodeCmd).toBe('npx opencode');
      expect(provider.useShell).toBe(true);
    });

    it('should configure base args correctly', () => {
      const provider = new OpenCodeProvider('anthropic/claude-sonnet-4');
      expect(provider.baseArgs).toContain('run');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('anthropic/claude-sonnet-4');
      expect(provider.baseArgs).toContain('--format');
      expect(provider.baseArgs).toContain('json');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new OpenCodeProvider('test-model', {
        extra_args: ['--verbose', '--timeout', '60']
      });
      expect(provider.baseArgs).toContain('--verbose');
      expect(provider.baseArgs).toContain('--timeout');
      expect(provider.baseArgs).toContain('60');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new OpenCodeProvider('special-model', {
        models: [
          { id: 'special-model', extra_args: ['--special-flag'] }
        ]
      });
      expect(provider.baseArgs).toContain('--special-flag');
    });

    it('should use config command over default', () => {
      const provider = new OpenCodeProvider('test-model', {
        command: '/path/to/opencode'
      });
      expect(provider.opencodeCmd).toBe('/path/to/opencode');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_OPENCODE_CMD = '/env/opencode';
      const provider = new OpenCodeProvider('test-model', {
        command: '/config/opencode'
      });
      expect(provider.opencodeCmd).toBe('/env/opencode');
    });

    it('should merge env from provider config', () => {
      const provider = new OpenCodeProvider('test-model', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new OpenCodeProvider('special-model', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'special-model', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });
  });

  describe('parseOpenCodeResponse', () => {
    it('should parse text parts from JSONL', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = [
        '{"type":"step_start","timestamp":1234}',
        '{"type":"text","part":{"type":"text","text":"{\\"findings\\":[]}"}}'
      ].join('\n');

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ findings: [] });
    });

    it('should accumulate text from multiple text events', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = [
        '{"type":"text","part":{"type":"text","text":"{\\"findi"}}',
        '{"type":"text","part":{"type":"text","text":"ngs\\":[]}"}}',
      ].join('\n');

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ findings: [] });
    });

    it('should handle parts array format', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = '{"parts":[{"type":"text","text":"{\\"key\\":\\"value\\"}"}]}';

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('should handle content array format', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = '{"content":[{"type":"text","text":"{\\"items\\":[1,2,3]}"}]}';

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ items: [1, 2, 3] });
    });

    it('should skip malformed JSONL lines gracefully', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = [
        '{"type":"text","part":{"type":"text","text":"{\\"valid\\":true}"}}',
        'not valid json at all',
        '{"type":"step_finish"}'
      ].join('\n');

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ valid: true });
    });

    it('should return failure when no valid JSON in text', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = '{"type":"text","part":{"type":"text","text":"Just plain text, no JSON"}}';

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(false);
    });

    it('should handle empty stdout', () => {
      const provider = new OpenCodeProvider('test-model');
      const result = provider.parseOpenCodeResponse('', 1);
      expect(result.success).toBe(false);
    });

    it('should extract JSON from markdown code blocks', () => {
      const provider = new OpenCodeProvider('test-model');
      const stdout = '{"type":"text","part":{"type":"text","text":"```json\\n{\\"wrapped\\":true}\\n```"}}';

      const result = provider.parseOpenCodeResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ wrapped: true });
    });
  });

  describe('logStreamLine', () => {
    let provider;
    const logger = require('../../src/utils/logger');

    beforeEach(() => {
      provider = new OpenCodeProvider('test-model');
      // Reset stream debug state before each test
      logger.setStreamDebugEnabled(false);
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
      const line = '{"type":"step_start","timestamp":1234}';
      // Should complete without throwing
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should not throw when stream debug is enabled', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type":"step_start","timestamp":1234}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle step_start events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type":"step_start","timestamp":1234}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle step_finish events with token counts without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { input: 100, output: 50, cache: { read: 25 } }
        }
      });
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle step_finish events without tokens without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'step_finish',
        part: { reason: 'stop' }
      });
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle text events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'text',
        part: { text: 'Some text content here' }
      });
      expect(() => provider.logStreamLine(line, 3, '[Level 2]')).not.toThrow();
    });

    it('should handle long text without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const longText = 'A'.repeat(100);
      const line = JSON.stringify({
        type: 'text',
        part: { text: longText }
      });
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle text with newlines without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'text',
        part: { text: 'Line1\nLine2\nLine3' }
      });
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle empty text events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'text',
        part: { text: '   ' }
      });
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_call events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_call',
        part: { name: 'read_file' }
      });
      expect(() => provider.logStreamLine(line, 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_use events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_use',
        part: { name: 'read_file', id: 'toolu_12345678' }
      });
      expect(() => provider.logStreamLine(line, 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_call with input arguments without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_call',
        part: {
          name: 'read_file',
          id: 'toolu_abc123',
          input: { file_path: '/path/to/file.js' }
        }
      });
      expect(() => provider.logStreamLine(line, 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_call with command input without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_call',
        part: {
          name: 'bash',
          input: { command: 'git diff HEAD~1' }
        }
      });
      expect(() => provider.logStreamLine(line, 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_result events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_result',
        part: { output: 'some result' }
      });
      expect(() => provider.logStreamLine(line, 6, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_result with error flag without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_result',
        part: {
          tool_use_id: 'toolu_abc123',
          is_error: true,
          output: 'File not found'
        }
      });
      expect(() => provider.logStreamLine(line, 6, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown event types without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'custom_event',
        data: 'something'
      });
      expect(() => provider.logStreamLine(line, 7, '[Level 1]')).not.toThrow();
    });

    it('should handle malformed JSON gracefully without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('not json', 1, '[Level 1]')).not.toThrow();
    });

    it('should handle empty line without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('', 1, '[Level 1]')).not.toThrow();
    });

    it('should handle event with missing part field without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'text' });
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('opencode');
      expect(RegisteredProvider).toBe(OpenCodeProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('opencode');
    });
  });
});
