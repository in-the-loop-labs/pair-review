// SPDX-License-Identifier: GPL-3.0-or-later
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

    it('should return gpt-5.2-codex as default model', () => {
      expect(CodexProvider.getDefaultModel()).toBe('gpt-5.2-codex');
    });

    it('should return array of models with expected structure', () => {
      const models = CodexProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(3);

      // Check that we have the expected model IDs
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('gpt-5.1-codex-mini');
      expect(modelIds).toContain('gpt-5.2-codex');
      expect(modelIds).toContain('gpt-5.3-codex');

      // Check model structure
      const defaultModel = models.find(m => m.id === 'gpt-5.2-codex');
      expect(defaultModel).toMatchObject({
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        tier: 'balanced',
        default: true
      });
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
      expect(provider.model).toBe('gpt-5.2-codex');
    });

    it('should create instance with specified model', () => {
      const provider = new CodexProvider('gpt-5.2-codex');
      expect(provider.model).toBe('gpt-5.2-codex');
    });

    it('should use default codex command', () => {
      const provider = new CodexProvider('gpt-5.2-codex');
      expect(provider.command).toBe('codex');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_CODEX_CMD environment variable', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = '/custom/codex';
      const provider = new CodexProvider('gpt-5.2-codex');
      expect(provider.command).toBe('/custom/codex');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = 'devx codex';
      const provider = new CodexProvider('gpt-5.2-codex');
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain('devx codex');
    });

    it('should configure base args correctly', () => {
      const provider = new CodexProvider('gpt-5.1-codex-mini');
      expect(provider.args).toContain('exec');
      expect(provider.args).toContain('-m');
      expect(provider.args).toContain('gpt-5.1-codex-mini');
      expect(provider.args).toContain('--json');
      expect(provider.args).toContain('--sandbox');
      expect(provider.args).toContain('workspace-write');
      expect(provider.args).toContain('--full-auto');
      expect(provider.args).toContain('-');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new CodexProvider('gpt-5.2-codex', {
        extra_args: ['--custom-flag', '--timeout', '60']
      });
      expect(provider.args).toContain('--custom-flag');
      expect(provider.args).toContain('--timeout');
      expect(provider.args).toContain('60');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new CodexProvider('gpt-5.2-codex', {
        models: [
          { id: 'gpt-5.2-codex', extra_args: ['--special-flag'] }
        ]
      });
      expect(provider.args).toContain('--special-flag');
    });

    it('should use config command over default', () => {
      const provider = new CodexProvider('gpt-5.2-codex', {
        command: '/path/to/codex'
      });
      expect(provider.command).toBe('/path/to/codex');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = '/env/codex';
      const provider = new CodexProvider('gpt-5.2-codex', {
        command: '/config/codex'
      });
      expect(provider.command).toBe('/env/codex');
    });

    it('should merge env from provider config', () => {
      const provider = new CodexProvider('gpt-5.2-codex', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new CodexProvider('gpt-5.2-codex', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'gpt-5.2-codex', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    describe('yolo mode', () => {
      it('should include sandbox restrictions by default and no dangerously-bypass flag', () => {
        const provider = new CodexProvider('gpt-5.1-codex-mini');
        expect(provider.args).toContain('--sandbox');
        expect(provider.args).toContain('workspace-write');
        expect(provider.args).toContain('--full-auto');
        expect(provider.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      });

      it('should use --dangerously-bypass-approvals-and-sandbox when yolo is true', () => {
        const provider = new CodexProvider('gpt-5.1-codex-mini', { yolo: true });
        expect(provider.args).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(provider.args).not.toContain('--sandbox');
        expect(provider.args).not.toContain('workspace-write');
        expect(provider.args).not.toContain('--full-auto');
      });

      it('should include sandbox restrictions when yolo is explicitly false', () => {
        const provider = new CodexProvider('gpt-5.1-codex-mini', { yolo: false });
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
      provider = new CodexProvider('gpt-5.2-codex');
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

  describe('getExtractionConfig', () => {
    it('should return correct config for default command', () => {
      const provider = new CodexProvider();
      const config = provider.getExtractionConfig('gpt-5.1-codex-mini');

      expect(config.command).toBe('codex');
      expect(config.args).toContain('exec');
      expect(config.args).toContain('-m');
      expect(config.args).toContain('gpt-5.1-codex-mini');
      expect(config.args).toContain('--sandbox');
      expect(config.args).toContain('read-only');
      expect(config.useShell).toBe(false);
      expect(config.promptViaStdin).toBe(true);
    });

    it('should use shell mode for multi-word command', () => {
      process.env.PAIR_REVIEW_CODEX_CMD = 'docker run codex';
      const provider = new CodexProvider();
      const config = provider.getExtractionConfig('gpt-5.1-codex-mini');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('docker run codex');
      expect(config.args).toEqual([]);
    });
  });

  describe('logStreamLine', () => {
    let provider;
    const logger = require('../../src/utils/logger');

    beforeEach(() => {
      provider = new CodexProvider('gpt-5.2-codex');
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
