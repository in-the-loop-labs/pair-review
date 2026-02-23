// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for GeminiProvider
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
const GeminiProvider = require('../../src/ai/gemini-provider');

describe('GeminiProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_GEMINI_CMD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(GeminiProvider.getProviderName()).toBe('Gemini');
    });

    it('should return correct provider ID', () => {
      expect(GeminiProvider.getProviderId()).toBe('gemini');
    });

    it('should return gemini-2.5-pro as default model', () => {
      expect(GeminiProvider.getDefaultModel()).toBe('gemini-2.5-pro');
    });

    it('should return array of models with expected structure', () => {
      const models = GeminiProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(4);

      // Check that we have the expected model IDs
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('gemini-3-flash');
      expect(modelIds).toContain('gemini-2.5-pro');
      expect(modelIds).toContain('gemini-3-pro');
      expect(modelIds).toContain('gemini-3.1-pro');

      // Check model structure
      const defaultModel = models.find(m => m.id === 'gemini-2.5-pro');
      expect(defaultModel).toMatchObject({
        id: 'gemini-2.5-pro',
        name: '2.5 Pro',
        tier: 'balanced',
        default: true
      });
    });

    it('should return install instructions', () => {
      const instructions = GeminiProvider.getInstallInstructions();
      expect(instructions).toContain('gemini');
      expect(instructions).toContain('npm');
    });
  });

  describe('constructor', () => {
    it('should create instance with default model', () => {
      const provider = new GeminiProvider();
      expect(provider.model).toBe('gemini-2.5-pro');
    });

    it('should create instance with specified model', () => {
      const provider = new GeminiProvider('gemini-3-pro');
      expect(provider.model).toBe('gemini-3-pro');
    });

    it('should use default gemini command', () => {
      const provider = new GeminiProvider('gemini-2.5-pro');
      expect(provider.command).toBe('gemini');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_GEMINI_CMD environment variable', () => {
      process.env.PAIR_REVIEW_GEMINI_CMD = '/custom/gemini';
      const provider = new GeminiProvider('gemini-2.5-pro');
      expect(provider.command).toBe('/custom/gemini');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_GEMINI_CMD = 'devx gemini';
      const provider = new GeminiProvider('gemini-2.5-pro');
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain('devx gemini');
    });

    it('should single-quote --allowed-tools value in shell mode command', () => {
      process.env.PAIR_REVIEW_GEMINI_CMD = 'devx gemini --';
      const provider = new GeminiProvider('gemini-2.5-pro');
      // The allowed-tools value contains shell metacharacters (parentheses, commas)
      // and must be single-quoted to prevent shell interpretation
      expect(provider.command).toMatch(/--allowed-tools '[^']+'/);
      expect(provider.command).toContain("'list_directory,read_file,glob,search_file_content,run_shell_command(git diff)");
    });

    it('should configure base args correctly with stream-json output', () => {
      const provider = new GeminiProvider('gemini-3-flash');
      expect(provider.args).toContain('-m');
      expect(provider.args).toContain('gemini-3-flash');
      expect(provider.args).toContain('-o');
      expect(provider.args).toContain('stream-json');
      expect(provider.args).toContain('--allowed-tools');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new GeminiProvider('gemini-2.5-pro', {
        extra_args: ['--custom-flag', '--timeout', '60']
      });
      expect(provider.args).toContain('--custom-flag');
      expect(provider.args).toContain('--timeout');
      expect(provider.args).toContain('60');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new GeminiProvider('gemini-3-pro', {
        models: [
          { id: 'gemini-3-pro', extra_args: ['--special-flag'] }
        ]
      });
      expect(provider.args).toContain('--special-flag');
    });

    it('should use config command over default', () => {
      const provider = new GeminiProvider('gemini-2.5-pro', {
        command: '/path/to/gemini'
      });
      expect(provider.command).toBe('/path/to/gemini');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_GEMINI_CMD = '/env/gemini';
      const provider = new GeminiProvider('gemini-2.5-pro', {
        command: '/config/gemini'
      });
      expect(provider.command).toBe('/env/gemini');
    });

    it('should merge env from provider config', () => {
      const provider = new GeminiProvider('gemini-2.5-pro', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new GeminiProvider('gemini-3-pro', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'gemini-3-pro', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    describe('yolo mode', () => {
      it('should include --allowed-tools and no --yolo flag by default', () => {
        const provider = new GeminiProvider('gemini-2.5-pro');
        expect(provider.args).toContain('--allowed-tools');
        expect(provider.args).not.toContain('--yolo');
      });

      it('should use --yolo instead of --allowed-tools when yolo is true', () => {
        const provider = new GeminiProvider('gemini-2.5-pro', { yolo: true });
        expect(provider.args).toContain('--yolo');
        expect(provider.args).not.toContain('--allowed-tools');
      });

      it('should use --allowed-tools when yolo is explicitly false', () => {
        const provider = new GeminiProvider('gemini-2.5-pro', { yolo: false });
        expect(provider.args).toContain('--allowed-tools');
        expect(provider.args).not.toContain('--yolo');
      });
    });
  });

  describe('parseGeminiResponse', () => {
    let provider;

    beforeEach(() => {
      provider = new GeminiProvider('gemini-2.5-pro');
    });

    describe('single assistant message extraction', () => {
      it('should extract JSON from single assistant message', () => {
        const stdout = [
          '{"type": "init", "session_id": "123", "model": "gemini-2.5-pro"}',
          '{"type": "message", "role": "user", "content": "hello"}',
          '{"type": "message", "role": "assistant", "content": "{\\"findings\\": []}", "delta": true}',
          '{"type": "result", "status": "success", "stats": {}}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ findings: [] });
      });

      it('should handle assistant message with embedded JSON in text', () => {
        const stdout = JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: 'Here is the analysis: {"suggestions": [{"id": 1}]}',
          delta: true
        });

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ suggestions: [{ id: 1 }] });
      });
    });

    describe('multiple assistant message accumulation', () => {
      it('should accumulate text from multiple assistant message events', () => {
        // Multiple assistant message events should have their text accumulated
        const stdout = [
          '{"type": "init"}',
          '{"type": "message", "role": "assistant", "content": "{\\"part1\\":", "delta": true}',
          '{"type": "tool_use", "tool_name": "read_file"}',
          '{"type": "message", "role": "assistant", "content": " \\"value\\", \\"part2\\": 42}", "delta": true}',
          '{"type": "result"}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ part1: 'value', part2: 42 });
      });

      it('should accumulate text when tool use creates multiple assistant message events', () => {
        // Simulates what happens when Gemini uses a tool and produces multiple messages
        const stdout = [
          '{"type": "init", "session_id": "abc"}',
          '{"type": "message", "role": "user", "content": "analyze code"}',
          '{"type": "message", "role": "assistant", "content": "Let me analyze...", "delta": true}',
          '{"type": "tool_use", "tool_name": "read_file", "tool_id": "123"}',
          '{"type": "tool_result", "tool_id": "123", "status": "success", "output": "file contents"}',
          '{"type": "message", "role": "assistant", "content": "Based on the file, here is the result: {\\"issues\\": [\\"bug1\\"]}", "delta": true}',
          '{"type": "result", "status": "success"}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        // The JSON is extracted from the accumulated text
        expect(result.data).toEqual({ issues: ['bug1'] });
      });

      it('should handle three or more assistant message events', () => {
        const stdout = [
          '{"type": "message", "role": "assistant", "content": "{\\"a\\":", "delta": true}',
          '{"type": "message", "role": "assistant", "content": " 1, \\"b\\":", "delta": true}',
          '{"type": "message", "role": "assistant", "content": " 2, \\"c\\": 3}", "delta": true}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ a: 1, b: 2, c: 3 });
      });
    });

    describe('no assistant message fallback', () => {
      it('should try extractJSON from stdout when no assistant message found', () => {
        // When there's no assistant message, it should fall back to extracting JSON from raw stdout
        const stdout = '{"type": "result", "data": {"extracted": true}}';

        const result = provider.parseGeminiResponse(stdout, 1);
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

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('malformed JSONL handling', () => {
      it('should skip invalid JSON lines gracefully', () => {
        const stdout = [
          '{"type": "init"}',
          'not valid json at all',
          '{"type": "message", "role": "assistant", "content": "{\\"valid\\": true}", "delta": true}',
          '{ broken'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ valid: true });
      });

      it('should handle empty lines', () => {
        const stdout = [
          '',
          '{"type": "init"}',
          '',
          '{"type": "message", "role": "assistant", "content": "{\\"data\\": 123}", "delta": true}',
          ''
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ data: 123 });
      });

      it('should handle completely malformed input by trying extractJSON', () => {
        const stdout = '{"broken json';

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('assistant message without JSON', () => {
      it('should return error when assistant message text is not JSON', () => {
        const stdout = JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: 'Just plain text without any JSON structure.',
          delta: true
        });

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(false);
        expect(result.error).toContain('not valid JSON');
      });

      it('should handle assistant message with markdown-wrapped JSON', () => {
        const stdout = JSON.stringify({
          type: 'message',
          role: 'assistant',
          content: '```json\n{"wrapped": true}\n```',
          delta: true
        });

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ wrapped: true });
      });
    });

    describe('edge cases', () => {
      it('should handle empty response string', () => {
        const result = provider.parseGeminiResponse('', 1);
        expect(result.success).toBe(false);
      });

      it('should handle whitespace-only response', () => {
        const result = provider.parseGeminiResponse('   \n\t\n  ', 1);
        expect(result.success).toBe(false);
      });

      it('should skip non-assistant message events', () => {
        const stdout = [
          '{"type": "init", "session_id": "abc"}',
          '{"type": "message", "role": "user", "content": "question"}',
          '{"type": "tool_use", "tool_name": "read"}',
          '{"type": "message", "role": "assistant", "content": "{\\"answer\\": 42}", "delta": true}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ answer: 42 });
      });

      it('should handle message without role property', () => {
        const stdout = [
          '{"type": "message", "content": "no role"}',
          '{"type": "message", "role": "assistant", "content": "{\\"ok\\": true}", "delta": true}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ ok: true });
      });

      it('should handle assistant message without content property', () => {
        const stdout = [
          '{"type": "message", "role": "assistant"}',
          '{"type": "message", "role": "assistant", "content": "{\\"found\\": true}", "delta": true}'
        ].join('\n');

        const result = provider.parseGeminiResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ found: true });
      });
    });
  });

  describe('getExtractionConfig', () => {
    it('should return correct config for default command', () => {
      const provider = new GeminiProvider();
      const config = provider.getExtractionConfig('gemini-3-flash');

      expect(config.command).toBe('gemini');
      expect(config.args).toContain('-m');
      expect(config.args).toContain('gemini-3-flash');
      expect(config.args).toContain('-o');
      expect(config.args).toContain('text');
      expect(config.useShell).toBe(false);
      expect(config.promptViaStdin).toBe(true);
    });

    it('should use shell mode for multi-word command', () => {
      process.env.PAIR_REVIEW_GEMINI_CMD = 'docker run gemini';
      const provider = new GeminiProvider();
      const config = provider.getExtractionConfig('gemini-3-flash');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('docker run gemini');
      expect(config.args).toEqual([]);
    });
  });

  describe('logStreamLine', () => {
    let provider;
    const logger = require('../../src/utils/logger');

    beforeEach(() => {
      provider = new GeminiProvider('gemini-2.5-pro');
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
      const line = '{"type": "init", "session_id": "abc123"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should not throw when stream debug is enabled', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "init", "session_id": "abc123"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle init events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "init", "session_id": "abc123456789", "model": "gemini-2.5-pro"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant message events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "message", "role": "assistant", "content": "This is a test message", "delta": true}';
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle long assistant message content without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const longText = 'A'.repeat(100);
      const line = `{"type": "message", "role": "assistant", "content": "${longText}", "delta": true}`;
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle empty assistant message content without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "message", "role": "assistant", "content": "", "delta": true}';
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle user message events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "message", "role": "user", "content": "Hello there"}';
      expect(() => provider.logStreamLine(line, 4, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_use events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_use',
        tool_name: 'read_file',
        tool_id: 'tool_12345678',
        parameters: { file_path: '/path/to/file.js' }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_use with command parameter without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_use',
        tool_name: 'run_shell_command',
        tool_id: 'tool_abc',
        parameters: { command: 'git diff HEAD~1' }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 5, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_result events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_result',
        tool_id: 'tool_12345678',
        status: 'success',
        output: 'File contents here'
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 6, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_result with error status without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_result',
        tool_id: 'tool_12345678',
        status: 'error',
        output: 'Command failed'
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 6, '[Level 1]')).not.toThrow();
    });

    it('should handle result events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "result", "status": "success", "stats": {"total_tokens": 1000, "input_tokens": 500, "output_tokens": 500, "duration_ms": 2500, "tool_calls": 3}}';
      expect(() => provider.logStreamLine(line, 10, '[Level 1]')).not.toThrow();
    });

    it('should handle result events with missing stats', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "result", "status": "success"}';
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

    it('should handle message without role property without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "message", "content": "no role"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant message without content property without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "message", "role": "assistant"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('gemini');
      expect(RegisteredProvider).toBe(GeminiProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('gemini');
    });
  });
});
