// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Unit tests for CursorAgentProvider
 *
 * These tests focus on static methods, constructor behavior, response parsing,
 * and stream logging without requiring actual CLI processes.
 *
 * Note: execute() tests that require child_process.spawn mocking are not yet
 * implemented (would need a separate file for module isolation).
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
const CursorAgentProvider = require('../../src/ai/cursor-agent-provider');

describe('CursorAgentProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_CURSOR_AGENT_CMD;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(CursorAgentProvider.getProviderName()).toBe('Cursor');
    });

    it('should return correct provider ID', () => {
      expect(CursorAgentProvider.getProviderId()).toBe('cursor-agent');
    });

    it('should return sonnet-4.5-thinking as default model', () => {
      expect(CursorAgentProvider.getDefaultModel()).toBe('sonnet-4.5-thinking');
    });

    it('should return array of models with expected structure', () => {
      const models = CursorAgentProvider.getModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(10);

      // Check that we have the expected model IDs
      const modelIds = models.map(m => m.id);
      expect(modelIds).toContain('auto');
      expect(modelIds).toContain('composer-1.5');
      expect(modelIds).toContain('composer-1');
      expect(modelIds).toContain('gpt-5.3-codex-fast');
      expect(modelIds).toContain('gemini-3-flash');
      expect(modelIds).toContain('sonnet-4.5-thinking');
      expect(modelIds).toContain('gemini-3-pro');
      expect(modelIds).toContain('gpt-5.3-codex-high');
      expect(modelIds).toContain('opus-4.5-thinking');
      expect(modelIds).toContain('opus-4.6-thinking');

      // Check model structure for the default model
      const defaultModel = models.find(m => m.id === 'sonnet-4.5-thinking');
      expect(defaultModel).toMatchObject({
        id: 'sonnet-4.5-thinking',
        name: 'Claude 4.5 Sonnet (Thinking)',
        tier: 'balanced',
        default: true
      });
    });

    it('should have correct tier assignments', () => {
      const models = CursorAgentProvider.getModels();
      const tierMap = Object.fromEntries(models.map(m => [m.id, m.tier]));
      expect(tierMap['auto']).toBe('free');
      expect(tierMap['composer-1.5']).toBe('balanced');
      expect(tierMap['composer-1']).toBe('fast');
      expect(tierMap['gpt-5.3-codex-fast']).toBe('fast');
      expect(tierMap['gemini-3-flash']).toBe('fast');
      expect(tierMap['sonnet-4.5-thinking']).toBe('balanced');
      expect(tierMap['gemini-3-pro']).toBe('balanced');
      expect(tierMap['gpt-5.3-codex-high']).toBe('thorough');
      expect(tierMap['opus-4.5-thinking']).toBe('thorough');
      expect(tierMap['opus-4.6-thinking']).toBe('thorough');
    });

    it('should return install instructions', () => {
      const instructions = CursorAgentProvider.getInstallInstructions();
      expect(instructions).toContain('Cursor');
      expect(instructions).toContain('agent');
    });
  });

  describe('constructor', () => {
    it('should create instance with default model', () => {
      const provider = new CursorAgentProvider();
      expect(provider.model).toBe('sonnet-4.5-thinking');
    });

    it('should create instance with specified model', () => {
      const provider = new CursorAgentProvider('opus-4.6-thinking');
      expect(provider.model).toBe('opus-4.6-thinking');
    });

    it('should use default agent command', () => {
      const provider = new CursorAgentProvider('sonnet-4.5');
      expect(provider.command).toBe('agent');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_CURSOR_AGENT_CMD environment variable', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = '/custom/agent';
      const provider = new CursorAgentProvider('sonnet-4.5');
      expect(provider.command).toBe('/custom/agent');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = 'devx agent';
      const provider = new CursorAgentProvider('sonnet-4.5');
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain('devx agent');
    });

    it('should quote shell-sensitive extra_args in shell mode command', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = 'devx agent --';
      const provider = new CursorAgentProvider('sonnet-4.5-thinking', {
        extra_args: ['--flag', 'value(test)']
      });
      // In shell mode, the command string should have parentheses-containing args quoted
      expect(provider.useShell).toBe(true);
      expect(provider.command).toContain("'value(test)'");
    });

    it('should configure base args correctly', () => {
      const provider = new CursorAgentProvider('gemini-3-flash');
      expect(provider.args).toContain('-p');
      expect(provider.args).toContain('--output-format');
      expect(provider.args).toContain('stream-json');
      expect(provider.args).toContain('--stream-partial-output');
      expect(provider.args).toContain('--model');
      expect(provider.args).toContain('gemini-3-flash');
      expect(provider.args).toContain('--sandbox');
      expect(provider.args).toContain('enabled');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new CursorAgentProvider('sonnet-4.5', {
        extra_args: ['--custom-flag', '--timeout', '60']
      });
      expect(provider.args).toContain('--custom-flag');
      expect(provider.args).toContain('--timeout');
      expect(provider.args).toContain('60');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new CursorAgentProvider('opus-4.6-thinking', {
        models: [
          { id: 'opus-4.6-thinking', extra_args: ['--special-flag'] }
        ]
      });
      expect(provider.args).toContain('--special-flag');
    });

    it('should use config command over default', () => {
      const provider = new CursorAgentProvider('sonnet-4.5', {
        command: '/path/to/agent'
      });
      expect(provider.command).toBe('/path/to/agent');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = '/env/agent';
      const provider = new CursorAgentProvider('sonnet-4.5', {
        command: '/config/agent'
      });
      expect(provider.command).toBe('/env/agent');
    });

    it('should merge env from provider config', () => {
      const provider = new CursorAgentProvider('sonnet-4.5', {
        env: { CUSTOM_VAR: 'value' }
      });
      expect(provider.extraEnv).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new CursorAgentProvider('opus-4.6-thinking', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'opus-4.6-thinking', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    describe('yolo mode', () => {
      it('should include sandbox enabled by default', () => {
        const provider = new CursorAgentProvider('gemini-3-flash');
        expect(provider.args).toContain('--sandbox');
        expect(provider.args).toContain('enabled');
      });

      it('should disable sandbox when yolo is true', () => {
        const provider = new CursorAgentProvider('gemini-3-flash', { yolo: true });
        expect(provider.args).toContain('--sandbox');
        expect(provider.args).toContain('disabled');
        expect(provider.args).not.toContain('enabled');
      });

      it('should include sandbox enabled when yolo is explicitly false', () => {
        const provider = new CursorAgentProvider('gemini-3-flash', { yolo: false });
        expect(provider.args).toContain('--sandbox');
        expect(provider.args).toContain('enabled');
      });
    });
  });

  describe('parseCursorAgentResponse', () => {
    let provider;

    beforeEach(() => {
      provider = new CursorAgentProvider('sonnet-4.5');
    });

    describe('assistant text extraction', () => {
      it('should extract JSON from assistant message content', () => {
        const stdout = [
          '{"type": "system", "subtype": "init", "session_id": "abc", "model": "Claude 4.5 Sonnet"}',
          '{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "test"}]}}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"findings\\": []}"}]}}',
          '{"type": "result", "subtype": "success", "duration_ms": 1000, "result": "{\\"findings\\": []}"}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ findings: [] });
      });

      it('should handle assistant message with embedded JSON in text', () => {
        const stdout = JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is the analysis: {"suggestions": [{"id": 1}]}' }]
          }
        });

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ suggestions: [{ id: 1 }] });
      });

      it('should skip streaming delta events and use final complete message', () => {
        // With --stream-partial-output, deltas have timestamp_ms,
        // while the final complete message does not
        const stdout = [
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"partial\\":"}]}, "timestamp_ms": 1000}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"partial\\": \\"val"}]}, "timestamp_ms": 1001}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"complete\\": true}"}]}}',
          '{"type": "result", "subtype": "success", "result": "{\\"complete\\": true}"}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ complete: true });
      });
    });

    describe('multiple assistant messages (multi-turn with tools)', () => {
      it('should accumulate text from multiple complete assistant messages', () => {
        const stdout = [
          '{"type": "system", "subtype": "init", "session_id": "abc"}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Let me analyze..."}]}}',
          '{"type": "tool_call", "subtype": "started", "call_id": "tool1"}',
          '{"type": "tool_call", "subtype": "completed", "call_id": "tool1"}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Based on the file: {\\"issues\\": [\\"bug1\\"]}"}]}}',
          '{"type": "result", "subtype": "success", "result": "accumulated text"}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ issues: ['bug1'] });
      });
    });

    describe('result text fallback', () => {
      it('should fall back to result text when assistant text has no JSON', () => {
        const stdout = [
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Just plain text without JSON."}]}}',
          '{"type": "result", "subtype": "success", "result": "{\\"fallback\\": true}"}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ fallback: true });
      });

      it('should use result text when no assistant messages exist', () => {
        const stdout = [
          '{"type": "system", "subtype": "init"}',
          '{"type": "result", "subtype": "success", "result": "{\\"data\\": 42}"}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ data: 42 });
      });
    });

    describe('no JSON found', () => {
      it('should return error when no JSON found anywhere', () => {
        const stdout = [
          'plain text line 1',
          'plain text line 2',
          'no json here'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(false);
      });

      it('should return error when assistant text is not JSON and no result', () => {
        const stdout = JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Just plain text without any JSON structure.' }]
          }
        });

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('malformed JSONL handling', () => {
      it('should skip invalid JSON lines gracefully', () => {
        const stdout = [
          '{"type": "system", "subtype": "init"}',
          'not valid json at all',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"valid\\": true}"}]}}',
          '{ broken'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ valid: true });
      });

      it('should handle empty lines', () => {
        const stdout = [
          '',
          '{"type": "system", "subtype": "init"}',
          '',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"data\\": 123}"}]}}',
          ''
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ data: 123 });
      });

      it('should handle completely malformed input by trying extractJSON', () => {
        const stdout = '{"broken json';

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(false);
      });
    });

    describe('markdown-wrapped JSON', () => {
      it('should handle assistant text with markdown-wrapped JSON', () => {
        const stdout = JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '```json\n{"wrapped": true}\n```' }]
          }
        });

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ wrapped: true });
      });
    });

    describe('edge cases', () => {
      it('should handle empty response string', () => {
        const result = provider.parseCursorAgentResponse('', 1);
        expect(result.success).toBe(false);
      });

      it('should handle whitespace-only response', () => {
        const result = provider.parseCursorAgentResponse('   \n\t\n  ', 1);
        expect(result.success).toBe(false);
      });

      it('should handle assistant message without content', () => {
        const stdout = [
          '{"type": "assistant", "message": {"role": "assistant"}}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"ok\\": true}"}]}}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ ok: true });
      });

      it('should handle assistant content with non-text blocks', () => {
        const stdout = [
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "image", "data": "..."}]}}',
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"found\\": true}"}]}}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ found: true });
      });

      it('should handle result event with is_error', () => {
        const stdout = [
          '{"type": "result", "subtype": "error", "is_error": true, "result": "Something went wrong"}'
        ].join('\n');

        // Result text is not JSON, so extraction should fail
        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(false);
      });

      it('should prefer assistant text JSON over result text JSON', () => {
        const stdout = [
          '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "{\\"source\\": \\"assistant\\"}"}]}}',
          '{"type": "result", "subtype": "success", "result": "{\\"source\\": \\"result\\"}"}'
        ].join('\n');

        const result = provider.parseCursorAgentResponse(stdout, 1);
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ source: 'assistant' });
      });
    });
  });

  describe('getExtractionConfig', () => {
    it('should return correct config for default command', () => {
      const provider = new CursorAgentProvider();
      const config = provider.getExtractionConfig('gemini-3-flash');

      expect(config.command).toBe('agent');
      expect(config.args).toContain('-p');
      expect(config.args).toContain('--output-format');
      expect(config.args).toContain('text');
      expect(config.args).toContain('--model');
      expect(config.args).toContain('gemini-3-flash');
      expect(config.useShell).toBe(false);
      expect(config.promptViaStdin).toBe(true);
    });

    it('should not include stream-json for extraction (uses text)', () => {
      const provider = new CursorAgentProvider();
      const config = provider.getExtractionConfig('auto');

      // Extraction should use text format, not stream-json
      const formatIdx = config.args.indexOf('--output-format');
      expect(formatIdx).toBeGreaterThanOrEqual(0);
      expect(config.args[formatIdx + 1]).toBe('text');
    });

    it('should use shell mode for multi-word command', () => {
      process.env.PAIR_REVIEW_CURSOR_AGENT_CMD = 'docker run agent';
      const provider = new CursorAgentProvider();
      const config = provider.getExtractionConfig('auto');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('docker run agent');
      expect(config.args).toEqual([]);
    });

    it('should include provider extra_args in extraction config', () => {
      const provider = new CursorAgentProvider('sonnet-4.5', {
        extra_args: ['--custom']
      });
      const config = provider.getExtractionConfig('auto');

      expect(config.args).toContain('--custom');
    });
  });

  describe('logStreamLine', () => {
    let provider;
    const logger = require('../../src/utils/logger');

    beforeEach(() => {
      provider = new CursorAgentProvider('sonnet-4.5');
      vi.clearAllMocks();
    });

    afterEach(() => {
      // Ensure stream debug is disabled after tests
      logger.setStreamDebugEnabled(false);
    });

    it('should not throw when stream debug is disabled', () => {
      logger.setStreamDebugEnabled(false);
      const line = '{"type": "system", "subtype": "init", "session_id": "abc123"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should not throw when stream debug is enabled', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "system", "subtype": "init", "session_id": "abc123"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle system init events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "system", "subtype": "init", "session_id": "abc123456789", "model": "Claude 4.5 Sonnet"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle user events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "test prompt"}]}}';
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "analysis result"}]}}';
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant streaming delta events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "partial"}]}, "timestamp_ms": 1234}';
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle long assistant text without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const longText = 'A'.repeat(100);
      const line = `{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "${longText}"}]}}`;
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_call started events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_12345678',
        tool_call: {
          shellToolCall: {
            args: { command: 'git diff HEAD~1' }
          }
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 4, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_call completed events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'tool_12345678',
        tool_call: {
          shellToolCall: {
            result: { rejected: { command: 'echo hello', reason: '' } }
          }
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 5, '[Level 1]')).not.toThrow();
    });

    it('should handle readToolCall events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_read123',
        tool_call: {
          readToolCall: {
            args: { path: '/path/to/file.js' }
          }
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 6, '[Level 1]')).not.toThrow();
    });

    it('should handle editToolCall events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_edit123',
        tool_call: {
          editToolCall: {
            args: { path: '/path/to/file.js' }
          }
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 7, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown tool call types without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const event = {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'tool_unknown',
        tool_call: {
          customToolCall: {
            args: {}
          }
        }
      };
      expect(() => provider.logStreamLine(JSON.stringify(event), 8, '[Level 1]')).not.toThrow();
    });

    it('should handle result events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "result", "subtype": "success", "duration_ms": 5000, "duration_api_ms": 4500, "is_error": false, "result": "analysis complete"}';
      expect(() => provider.logStreamLine(line, 10, '[Level 1]')).not.toThrow();
    });

    it('should handle result events with is_error without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "result", "subtype": "error", "duration_ms": 1000, "is_error": true, "result": "error message"}';
      expect(() => provider.logStreamLine(line, 10, '[Level 1]')).not.toThrow();
    });

    it('should process result events even when stream debug is disabled', () => {
      // Result events are always logged at info level, not gated by stream debug
      logger.setStreamDebugEnabled(false);
      const line = '{"type": "result", "subtype": "success", "duration_ms": 5000, "result": "some result"}';
      // Should not throw - verifies result events are handled even with stream debug off
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

    it('should handle empty tool_call without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "tool_call", "subtype": "started", "tool_call": {}}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle user event without content without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "user", "message": {"role": "user"}}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle assistant event without content without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type": "assistant", "message": {"role": "assistant"}}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('cursor-agent');
      expect(RegisteredProvider).toBe(CursorAgentProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('cursor-agent');
    });
  });
});
