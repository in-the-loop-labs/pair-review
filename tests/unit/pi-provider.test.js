// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach, afterAll } from 'vitest';

/**
 * Unit tests for PiProvider
 *
 * These tests focus on static methods, constructor behavior, response parsing,
 * and streaming line logging without requiring actual CLI processes.
 */

// Patch child_process.spawn with a mock that delegates to the real implementation
// by default. This must happen BEFORE pi-provider.js is loaded (via require below),
// because pi-provider destructures spawn at import time:
//   const { spawn } = require('child_process');
// vitest's vi.mock does not intercept CJS require for Node built-in modules,
// so we patch the module object directly instead.
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const mockSpawn = vi.fn((...args) => realSpawn(...args));
childProcess.spawn = mockSpawn;

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
const PiProvider = require('../../src/ai/pi-provider');
const { _extractAssistantText: extractAssistantText } = require('../../src/ai/pi-provider');

describe('PiProvider', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    // Restore the real spawn on child_process module
    childProcess.spawn = realSpawn;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment for each test
    delete process.env.PAIR_REVIEW_PI_CMD;
    delete process.env.PAIR_REVIEW_PI_SESSION;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('static methods', () => {
    it('should return correct provider name', () => {
      expect(PiProvider.getProviderName()).toBe('Pi');
    });

    it('should return correct provider ID', () => {
      expect(PiProvider.getProviderId()).toBe('pi');
    });

    it('should return default as the default model', () => {
      expect(PiProvider.getDefaultModel()).toBe('default');
    });

    it('should return built-in model definitions', () => {
      const models = PiProvider.getModels();
      expect(models.length).toBeGreaterThanOrEqual(2);
      expect(models.find(m => m.id === 'default')).toBeDefined();
      expect(models.find(m => m.id === 'multi-model')).toBeDefined();
    });

    it('should return install instructions with pi-mono', () => {
      const instructions = PiProvider.getInstallInstructions();
      expect(instructions).toContain('pi-coding-agent');
      expect(instructions).toContain('npm');
    });
  });

  describe('constructor', () => {
    it('should create instance with default model when no model provided', () => {
      const provider = new PiProvider();
      expect(provider.model).toBe('default');
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should create instance with default model when null model provided', () => {
      const provider = new PiProvider(null);
      expect(provider.model).toBe('default');
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should create instance with specified model', () => {
      const provider = new PiProvider('gemini-2.5-flash');
      expect(provider.model).toBe('gemini-2.5-flash');
    });

    it('should use default pi command', () => {
      const provider = new PiProvider('test-model');
      expect(provider.piCmd).toBe('pi');
      expect(provider.useShell).toBe(false);
    });

    it('should respect PAIR_REVIEW_PI_CMD environment variable', () => {
      process.env.PAIR_REVIEW_PI_CMD = '/custom/pi';
      const provider = new PiProvider('test-model');
      expect(provider.piCmd).toBe('/custom/pi');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_PI_CMD = 'npx pi';
      const provider = new PiProvider('test-model');
      expect(provider.piCmd).toBe('npx pi');
      expect(provider.useShell).toBe(true);
    });

    it('should quote shell-sensitive extra_args in getExtractionConfig shell mode command', () => {
      process.env.PAIR_REVIEW_PI_CMD = 'devx pi --';
      const provider = new PiProvider('test-model', {
        extra_args: ['--flag', 'value(test)']
      });
      // Pi builds the full command in getExtractionConfig(), so test via that method
      const config = provider.getExtractionConfig('test-model');
      expect(config.useShell).toBe(true);
      // The extra arg with parentheses should be single-quoted
      expect(config.command).toContain("'value(test)'");
    });

    it('should configure base args correctly', () => {
      const provider = new PiProvider('gemini-2.5-flash');
      expect(provider.baseArgs).toContain('-p');
      expect(provider.baseArgs).toContain('--mode');
      expect(provider.baseArgs).toContain('json');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('gemini-2.5-flash');
      expect(provider.baseArgs).toContain('--tools');
      expect(provider.baseArgs).toContain('read,bash,grep,find,ls');
      expect(provider.baseArgs).toContain('--no-session');
      // Task extension loaded, auto-discovery disabled
      expect(provider.baseArgs).toContain('-e');
      expect(provider.baseArgs).toContain('--no-extensions');
      expect(provider.baseArgs).toContain('--no-skills');
      expect(provider.baseArgs).toContain('--no-prompt-templates');
    });

    it('should merge provider extra_args from config', () => {
      const provider = new PiProvider('test-model', {
        extra_args: ['--verbose', '--thinking', 'high']
      });
      expect(provider.baseArgs).toContain('--verbose');
      expect(provider.baseArgs).toContain('--thinking');
      expect(provider.baseArgs).toContain('high');
    });

    it('should merge model-specific extra_args from config', () => {
      const provider = new PiProvider('special-model', {
        models: [
          { id: 'special-model', extra_args: ['--thinking', 'high'] }
        ]
      });
      expect(provider.baseArgs).toContain('--thinking');
      expect(provider.baseArgs).toContain('high');
    });

    it('should use config command over default', () => {
      const provider = new PiProvider('test-model', {
        command: '/path/to/pi'
      });
      expect(provider.piCmd).toBe('/path/to/pi');
    });

    it('should prefer ENV command over config command', () => {
      process.env.PAIR_REVIEW_PI_CMD = '/env/pi';
      const provider = new PiProvider('test-model', {
        command: '/config/pi'
      });
      expect(provider.piCmd).toBe('/env/pi');
    });

    it('should set PI_CMD in extraEnv to the resolved pi command', () => {
      process.env.PAIR_REVIEW_PI_CMD = '/custom/pi';
      const provider = new PiProvider('test-model');
      expect(provider.extraEnv.PI_CMD).toBe('/custom/pi');
    });

    it('should merge env from provider config', () => {
      const provider = new PiProvider('test-model', {
        env: { GEMINI_API_KEY: 'test-key' }
      });
      expect(provider.extraEnv).toMatchObject({ GEMINI_API_KEY: 'test-key' });
      // PI_CMD is always set for the task extension
      expect(provider.extraEnv).toHaveProperty('PI_CMD', 'pi');
    });

    it('should merge model-specific env over provider env', () => {
      const provider = new PiProvider('special-model', {
        env: { VAR1: 'provider' },
        models: [
          { id: 'special-model', env: { VAR1: 'model', VAR2: 'extra' } }
        ]
      });
      expect(provider.extraEnv.VAR1).toBe('model');
      expect(provider.extraEnv.VAR2).toBe('extra');
    });

    it('should omit --no-session when PAIR_REVIEW_PI_SESSION is set', () => {
      process.env.PAIR_REVIEW_PI_SESSION = '1';
      const provider = new PiProvider('test-model');
      expect(provider.baseArgs).not.toContain('--no-session');
    });

    it('should include --no-session by default', () => {
      delete process.env.PAIR_REVIEW_PI_SESSION;
      const provider = new PiProvider('test-model');
      expect(provider.baseArgs).toContain('--no-session');
    });

    it('should omit --tools in yolo mode (all tools permitted)', () => {
      const provider = new PiProvider('test-model', { yolo: true });
      expect(provider.baseArgs).toContain('-p');
      expect(provider.baseArgs).toContain('--mode');
      expect(provider.baseArgs).toContain('json');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('test-model');
      expect(provider.baseArgs).toContain('--no-session');
      expect(provider.baseArgs).not.toContain('--tools');
      expect(provider.baseArgs).not.toContain('read,bash,grep,find,ls');
      expect(provider.baseArgs).toContain('-e');
      expect(provider.baseArgs).toContain('--no-extensions');
      expect(provider.baseArgs).toContain('--no-skills');
      expect(provider.baseArgs).toContain('--no-prompt-templates');
    });

    it('should include --tools in non-yolo mode (default)', () => {
      const provider = new PiProvider('test-model');
      expect(provider.baseArgs).toContain('--tools');
      expect(provider.baseArgs).toContain('read,bash,grep,find,ls');
    });

    it('should include --tools when yolo is explicitly false', () => {
      const provider = new PiProvider('test-model', { yolo: false });
      expect(provider.baseArgs).toContain('--tools');
      expect(provider.baseArgs).toContain('read,bash,grep,find,ls');
    });

    it('should merge extra_args in yolo mode', () => {
      const provider = new PiProvider('test-model', {
        yolo: true,
        extra_args: ['--verbose']
      });
      expect(provider.baseArgs).not.toContain('--tools');
      expect(provider.baseArgs).toContain('--verbose');
    });

    it('should suppress --model flag when cli_model is null (default mode)', () => {
      const provider = new PiProvider('default');
      expect(provider.baseArgs).not.toContain('--model');
      expect(provider.model).toBe('default');
    });

    it('should suppress --model flag for multi-model mode', () => {
      const provider = new PiProvider('multi-model');
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should include review skill in multi-model mode', () => {
      const provider = new PiProvider('multi-model');
      expect(provider.baseArgs).toContain('--skill');
      // Verify the skill path is included (it follows --skill)
      const skillIdx = provider.baseArgs.indexOf('--skill');
      expect(provider.baseArgs[skillIdx + 1]).toContain('review-model-guidance');
    });

    it('should fall back to default when no model provided', () => {
      const provider = new PiProvider(null);
      expect(provider.model).toBe('default');
      expect(provider.baseArgs).not.toContain('--model');
    });

    it('should use model id as --model value for non-built-in models', () => {
      const provider = new PiProvider('gemini-2.5-flash');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('gemini-2.5-flash');
    });

    it('should parse provider/model format into --provider and --model args', () => {
      const provider = new PiProvider('google/gemini-2.5-flash');
      expect(provider.baseArgs).toContain('--provider');
      expect(provider.baseArgs).toContain('google');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('gemini-2.5-flash');
    });

    it('should handle model without provider prefix', () => {
      const provider = new PiProvider('claude-haiku-4-5');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('claude-haiku-4-5');
      expect(provider.baseArgs).not.toContain('--provider');
    });

    it('should handle provider/model with slashes in model name', () => {
      const provider = new PiProvider('groq/meta-llama/llama-4-scout-17b-16e-instruct');
      expect(provider.baseArgs).toContain('--provider');
      expect(provider.baseArgs).toContain('groq');
      expect(provider.baseArgs).toContain('--model');
      expect(provider.baseArgs).toContain('meta-llama/llama-4-scout-17b-16e-instruct');
    });
  });

  describe('parsePiResponse', () => {
    it('should parse text from message_end events', () => {
      const provider = new PiProvider('test-model');
      const stdout = [
        '{"type":"session","version":3,"id":"test-session"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"findings\\":[]}"}]}}'
      ].join('\n');

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ findings: [] });
    });

    it('should parse text from turn_end events when message_end not found', () => {
      const provider = new PiProvider('test-model');
      const stdout = [
        '{"type":"session","version":3,"id":"test-session"}',
        '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"key\\":\\"value\\"}"}]}}'
      ].join('\n');

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('should parse text from agent_end events as fallback', () => {
      const provider = new PiProvider('test-model');
      const stdout = JSON.stringify({
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: '{"items":[1,2,3]}' }] }
        ]
      });

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ items: [1, 2, 3] });
    });

    it('should handle string content in message_end', () => {
      const provider = new PiProvider('test-model');
      const stdout = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: '{"simple":"string"}' }
      });

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ simple: 'string' });
    });

    it('should skip malformed JSONL lines gracefully', () => {
      const provider = new PiProvider('test-model');
      const stdout = [
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"valid\\":true}"}]}}',
        'not valid json at all',
        '{"type":"turn_start"}'
      ].join('\n');

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ valid: true });
    });

    it('should return failure when no valid JSON in text', () => {
      const provider = new PiProvider('test-model');
      const stdout = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Just plain text, no JSON"}]}}';

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(false);
    });

    it('should handle empty stdout', () => {
      const provider = new PiProvider('test-model');
      const result = provider.parsePiResponse('', 1);
      expect(result.success).toBe(false);
    });

    it('should extract JSON from markdown code blocks', () => {
      const provider = new PiProvider('test-model');
      const stdout = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"```json\\n{\\"wrapped\\":true}\\n```"}]}}';

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ wrapped: true });
    });

    it('should not duplicate text from message_end and turn_end', () => {
      const provider = new PiProvider('test-model');
      const sameText = '{"result":"data"}';
      const stdout = [
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: sameText }] }
        }),
        JSON.stringify({
          type: 'turn_end',
          message: { role: 'assistant', content: [{ type: 'text', text: sameText }] }
        })
      ].join('\n');

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'data' });
    });

    it('should ignore message_end events from non-assistant roles', () => {
      const provider = new PiProvider('test-model');
      const stdout = [
        '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"user message"}]}}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"found\\":true}"}]}}'
      ].join('\n');

      const result = provider.parsePiResponse(stdout, 1);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ found: true });
    });
  });

  describe('logStreamLine', () => {
    let provider;
    let streamDebugSpy;
    const logger = require('../../src/utils/logger');

    beforeEach(() => {
      provider = new PiProvider('test-model');
      logger.setStreamDebugEnabled(false);
      // Wrap the (possibly mocked) streamDebug in a fresh spy so assertions work
      // regardless of whether vi.clearAllMocks() reset the module-level mock
      streamDebugSpy = vi.spyOn(logger, 'streamDebug');
    });

    afterEach(() => {
      logger.setStreamDebugEnabled(false);
      streamDebugSpy.mockRestore();
    });

    it('should not throw when stream debug is disabled', () => {
      logger.setStreamDebugEnabled(false);
      const line = '{"type":"session","version":3,"id":"test"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should not throw when stream debug is enabled', () => {
      logger.setStreamDebugEnabled(true);
      const line = '{"type":"session","version":3,"id":"test"}';
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should log session event with session ID', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'session', version: 3, id: 'sess-123' });
      provider.logStreamLine(line, 1, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session started: sess-123')
      );
    });

    it('should handle turn_start events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'turn_start' });
      expect(() => provider.logStreamLine(line, 1, '[Level 1]')).not.toThrow();
    });

    it('should handle turn_end events with role without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant' }
      });
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle turn_end events without message without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'turn_end' });
      expect(() => provider.logStreamLine(line, 2, '[Level 1]')).not.toThrow();
    });

    it('should handle message_start events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'message_start',
        message: { role: 'assistant' }
      });
      expect(() => provider.logStreamLine(line, 3, '[Level 1]')).not.toThrow();
    });

    it('should log text_delta content in message_update events', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'Some streaming text'
        }
      });
      provider.logStreamLine(line, 4, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('text_delta: Some streaming text')
      );
    });

    it('should truncate long text_delta content to 60 chars', () => {
      logger.setStreamDebugEnabled(true);
      const longText = 'A'.repeat(100);
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          delta: longText
        }
      });
      provider.logStreamLine(line, 4, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('text_delta: ' + 'A'.repeat(60) + '...')
      );
    });

    it('should handle message_update without assistantMessageEvent without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'message_update' });
      expect(() => provider.logStreamLine(line, 4, '[Level 1]')).not.toThrow();
    });

    it('should handle message_end events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant' }
      });
      expect(() => provider.logStreamLine(line, 5, '[Level 1]')).not.toThrow();
    });

    it('should log tool_execution_start with tool name and file path', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_execution_start',
        toolName: 'read',
        toolCallId: 'call_abc123',
        args: { file_path: '/path/to/file.js' }
      });
      provider.logStreamLine(line, 6, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('tool_start: read')
      );
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('path="/path/to/file.js"')
      );
    });

    it('should log tool_execution_start with command args', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'git diff HEAD~1' }
      });
      provider.logStreamLine(line, 6, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('tool_start: bash')
      );
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('cmd="git diff HEAD~1"')
      );
    });

    it('should handle tool_execution_start without args without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_execution_start',
        toolName: 'read'
      });
      expect(() => provider.logStreamLine(line, 6, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_execution_update events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_execution_update',
        partialResult: 'some partial output'
      });
      expect(() => provider.logStreamLine(line, 7, '[Level 1]')).not.toThrow();
    });

    it('should handle tool_execution_update without partialResult without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'tool_execution_update' });
      expect(() => provider.logStreamLine(line, 7, '[Level 1]')).not.toThrow();
    });

    it('should log tool_execution_end with OK status', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_execution_end',
        result: 'file contents here',
        isError: false
      });
      provider.logStreamLine(line, 8, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('tool_end OK')
      );
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('file contents here')
      );
    });

    it('should log tool_execution_end with ERROR status', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'tool_execution_end',
        result: 'File not found',
        isError: true
      });
      provider.logStreamLine(line, 8, '[Level 1]');
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('tool_end ERROR')
      );
      expect(streamDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('File not found')
      );
    });

    it('should handle agent_start events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'agent_start' });
      expect(() => provider.logStreamLine(line, 9, '[Level 1]')).not.toThrow();
    });

    it('should handle agent_end events without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({ type: 'agent_end' });
      expect(() => provider.logStreamLine(line, 10, '[Level 1]')).not.toThrow();
    });

    it('should handle unknown event types without throwing', () => {
      logger.setStreamDebugEnabled(true);
      const line = JSON.stringify({
        type: 'auto_compaction_start',
        data: 'something'
      });
      expect(() => provider.logStreamLine(line, 11, '[Level 1]')).not.toThrow();
    });

    it('should handle malformed JSON gracefully without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('not json', 1, '[Level 1]')).not.toThrow();
    });

    it('should handle empty line without throwing', () => {
      logger.setStreamDebugEnabled(true);
      expect(() => provider.logStreamLine('', 1, '[Level 1]')).not.toThrow();
    });
  });

  describe('buildArgsForModel', () => {
    it('should include base args for the given model', () => {
      const provider = new PiProvider('test-model');
      const args = provider.buildArgsForModel('other-model');

      expect(args).toContain('-p');
      expect(args).toContain('--mode');
      expect(args).toContain('json');
      expect(args).toContain('--model');
      expect(args).toContain('other-model');
      expect(args).toContain('--no-tools');
      expect(args).toContain('--no-session');
    });

    it('should include provider-level extra_args', () => {
      const provider = new PiProvider('test-model', {
        extra_args: ['--verbose', '--thinking', 'high']
      });
      const args = provider.buildArgsForModel('any-model');

      expect(args).toContain('--verbose');
      expect(args).toContain('--thinking');
      expect(args).toContain('high');
    });

    it('should include model-specific extra_args for matching model', () => {
      const provider = new PiProvider('test-model', {
        models: [
          { id: 'fast-model', extra_args: ['--thinking', 'off'] },
          { id: 'slow-model', extra_args: ['--thinking', 'high'] }
        ]
      });

      const fastArgs = provider.buildArgsForModel('fast-model');
      expect(fastArgs).toContain('off');
      expect(fastArgs).not.toContain('high');

      const slowArgs = provider.buildArgsForModel('slow-model');
      expect(slowArgs).toContain('high');
    });

    it('should combine provider and model extra_args', () => {
      const provider = new PiProvider('test-model', {
        extra_args: ['--provider-arg'],
        models: [
          { id: 'special-model', extra_args: ['--model-arg'] }
        ]
      });
      const args = provider.buildArgsForModel('special-model');

      expect(args).toContain('--provider-arg');
      expect(args).toContain('--model-arg');
    });

    it('should not include model-specific args for non-matching model', () => {
      const provider = new PiProvider('test-model', {
        models: [
          { id: 'special-model', extra_args: ['--special-flag'] }
        ]
      });
      const args = provider.buildArgsForModel('other-model');

      expect(args).not.toContain('--special-flag');
    });

    it('should handle missing configOverrides gracefully', () => {
      const provider = new PiProvider('test-model');
      // Manually unset configOverrides to simulate edge case
      provider.configOverrides = undefined;
      const args = provider.buildArgsForModel('any-model');

      // Should still have base args
      expect(args).toContain('-p');
      expect(args).toContain('--model');
      expect(args).toContain('any-model');
    });
  });

  describe('getExtractionConfig', () => {
    afterEach(() => {
      delete process.env.PAIR_REVIEW_PI_CMD;
      delete process.env.PAIR_REVIEW_PI_SESSION;
    });

    it('should return correct structure for non-shell mode', () => {
      const provider = new PiProvider('test-model');
      const config = provider.getExtractionConfig('extraction-model');

      expect(config).toHaveProperty('command', 'pi');
      expect(config).toHaveProperty('args');
      expect(config).toHaveProperty('useShell', false);
      expect(config).toHaveProperty('promptViaStdin', true);
    });

    it('should include base args for the extraction model', () => {
      const provider = new PiProvider('test-model');
      const config = provider.getExtractionConfig('fast-model');

      expect(config.args).toContain('-p');
      expect(config.args).toContain('--mode');
      expect(config.args).toContain('json');
      expect(config.args).toContain('--model');
      expect(config.args).toContain('fast-model');
      expect(config.args).toContain('--no-tools');
      expect(config.args).toContain('--no-session');
    });

    it('should include provider-level extra_args in extraction config', () => {
      const provider = new PiProvider('main-model', {
        extra_args: ['--verbose']
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.args).toContain('--verbose');
    });

    it('should include model-specific extra_args for extraction model', () => {
      const provider = new PiProvider('main-model', {
        models: [
          { id: 'extraction-model', extra_args: ['--thinking', 'off'] },
          { id: 'main-model', extra_args: ['--thinking', 'high'] }
        ]
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.args).toContain('off');
      expect(config.args).not.toContain('high');
    });

    it('should use shell mode for multi-word commands', () => {
      process.env.PAIR_REVIEW_PI_CMD = 'npx pi';
      const provider = new PiProvider('test-model', {
        extra_args: ['--verbose']
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('npx pi');
      expect(config.command).toContain('--verbose');
      expect(config.args).toEqual([]);
    });

    it('should use configured command in shell mode', () => {
      const provider = new PiProvider('test-model', {
        command: 'docker run pi'
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('docker run pi');
      expect(config.command).toContain('--model');
      expect(config.command).toContain('extraction-model');
    });

    it('should include all args in command string for shell mode', () => {
      process.env.PAIR_REVIEW_PI_CMD = 'npx pi';
      const provider = new PiProvider('test-model', {
        extra_args: ['--thinking', 'medium'],
        models: [
          { id: 'fast-model', extra_args: ['--thinking', 'off'] }
        ]
      });
      const config = provider.getExtractionConfig('fast-model');

      expect(config.useShell).toBe(true);
      expect(config.command).toContain('--thinking');
      expect(config.command).toContain('fast-model');
    });

    it('should include env field with extraEnv in non-shell mode', () => {
      const provider = new PiProvider('test-model', {
        env: { GEMINI_API_KEY: 'test-key-123' }
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config).toHaveProperty('env');
      expect(config.env).toMatchObject({ GEMINI_API_KEY: 'test-key-123' });
    });

    it('should include env field with extraEnv in shell mode', () => {
      process.env.PAIR_REVIEW_PI_CMD = 'npx pi';
      const provider = new PiProvider('test-model', {
        env: { API_KEY: 'shell-key' }
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.useShell).toBe(true);
      expect(config).toHaveProperty('env');
      expect(config.env).toMatchObject({ API_KEY: 'shell-key' });
    });

    it('should include merged provider and model env in env field', () => {
      const provider = new PiProvider('special-model', {
        env: { VAR1: 'provider-val' },
        models: [
          { id: 'special-model', env: { VAR1: 'model-val', VAR2: 'extra' } }
        ]
      });
      const config = provider.getExtractionConfig('extraction-model');

      expect(config.env).toMatchObject({ VAR1: 'model-val', VAR2: 'extra' });
    });

    it('should omit --no-session in extraction config when PAIR_REVIEW_PI_SESSION is set', () => {
      process.env.PAIR_REVIEW_PI_SESSION = '1';
      const provider = new PiProvider('test-model');
      const config = provider.getExtractionConfig('extraction-model');
      if (config.useShell) {
        expect(config.command).not.toContain('--no-session');
      } else {
        expect(config.args).not.toContain('--no-session');
      }
    });

    it('should include task extension env vars for subtask support', () => {
      const provider = new PiProvider('test-model');
      const config = provider.getExtractionConfig('extraction-model');

      expect(config).toHaveProperty('env');
      expect(config.env).toEqual({ PI_CMD: 'pi', PI_TASK_MAX_DEPTH: '1' });
    });
  });

  describe('extractAssistantText', () => {
    it('should extract text from array content blocks', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' World' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('Hello World');
    });

    it('should extract text from string content', () => {
      const seenTexts = new Set();
      const result = extractAssistantText('Simple string', seenTexts);
      expect(result).toBe('Simple string');
    });

    it('should skip non-text blocks', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'tool_use', text: 'should be ignored' },
        { type: 'text', text: 'real text' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('real text');
    });

    it('should skip blocks without text', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'text' },
        { type: 'text', text: null },
        { type: 'text', text: 'valid' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('valid');
    });

    it('should dedup identical text blocks using Set', () => {
      const seenTexts = new Set();
      const content = [
        { type: 'text', text: 'same text' },
        { type: 'text', text: 'same text' }
      ];
      const result = extractAssistantText(content, seenTexts);
      expect(result).toBe('same text');
    });

    it('should dedup across multiple calls with shared Set', () => {
      const seenTexts = new Set();
      const content1 = [{ type: 'text', text: 'first pass' }];
      const content2 = [{ type: 'text', text: 'first pass' }];
      const r1 = extractAssistantText(content1, seenTexts);
      const r2 = extractAssistantText(content2, seenTexts);
      expect(r1).toBe('first pass');
      expect(r2).toBe('');
    });

    it('should not incorrectly dedup substring matches', () => {
      // This is the key fix: substring "abc" is contained in "abcdef",
      // but they are different text blocks and should NOT be deduped
      const seenTexts = new Set();
      const content1 = [{ type: 'text', text: 'abcdef' }];
      const content2 = [{ type: 'text', text: 'abc' }];
      const r1 = extractAssistantText(content1, seenTexts);
      const r2 = extractAssistantText(content2, seenTexts);
      expect(r1).toBe('abcdef');
      expect(r2).toBe('abc');
    });

    it('should handle null content', () => {
      const seenTexts = new Set();
      const result = extractAssistantText(null, seenTexts);
      expect(result).toBe('');
    });

    it('should handle undefined content', () => {
      const seenTexts = new Set();
      const result = extractAssistantText(undefined, seenTexts);
      expect(result).toBe('');
    });

    it('should handle empty array', () => {
      const seenTexts = new Set();
      const result = extractAssistantText([], seenTexts);
      expect(result).toBe('');
    });

    it('should handle empty string', () => {
      const seenTexts = new Set();
      const result = extractAssistantText('', seenTexts);
      // Empty string is falsy, handled by the typeof check
      expect(result).toBe('');
    });

    it('should handle number content (not array or string)', () => {
      const seenTexts = new Set();
      const result = extractAssistantText(42, seenTexts);
      expect(result).toBe('');
    });
  });

  describe('parsePiResponse dedup uses exact matching (not substring)', () => {
    it('should not dedup texts that are substrings of each other', () => {
      const provider = new PiProvider('test-model');
      // "abc" is a substring of "abcdef", but they are different blocks
      const stdout = [
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '{"part":"one"}' }] }
        }),
        JSON.stringify({
          type: 'turn_end',
          message: { role: 'assistant', content: [{ type: 'text', text: '{"part":"one"} extra' }] }
        })
      ].join('\n');

      const result = provider.parsePiResponse(stdout, 1);
      // Both texts should be included since they are different (exact match, not substring)
      expect(result.success).toBe(true);
    });
  });

  describe('testAvailability', () => {
    afterEach(() => {
      delete process.env.PAIR_REVIEW_PI_CMD;
      delete process.env.PAIR_REVIEW_PI_SESSION;
      vi.useRealTimers();
    });

    it('should resolve true when CLI command succeeds', async () => {
      // Use 'echo' as a fake CLI that exits with 0 and outputs a version
      process.env.PAIR_REVIEW_PI_CMD = 'echo';
      const provider = new PiProvider('test-model');
      const result = await provider.testAvailability();
      expect(result).toBe(true);
    });

    it('should resolve false when CLI command fails', async () => {
      // Use a command that exits with non-zero (false always exits 1)
      process.env.PAIR_REVIEW_PI_CMD = 'false';
      const provider = new PiProvider('test-model');
      const result = await provider.testAvailability();
      expect(result).toBe(false);
    });

    it('should resolve false when CLI command not found', async () => {
      // Use a non-existent command
      process.env.PAIR_REVIEW_PI_CMD = '/nonexistent/binary/that/does/not/exist';
      const provider = new PiProvider('test-model');
      const result = await provider.testAvailability();
      expect(result).toBe(false);
    });

    it('should pass extraEnv values to spawn env', async () => {
      const { EventEmitter } = require('events');

      // Create a fake child process that emits 'close' with code 0
      const fakeChild = new EventEmitter();
      fakeChild.stdout = new EventEmitter();
      fakeChild.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new PiProvider('test-model', {
        env: { MY_API_KEY: 'test-key-123' }
      });
      const resultPromise = provider.testAvailability();

      // Emit close to resolve the promise
      fakeChild.emit('close', 0);
      await resultPromise;

      // Verify spawn was called with env containing our extraEnv values
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
      fakeChild.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new PiProvider('test-model');
      const resultPromise = provider.testAvailability();

      // Advance time past the 10s timeout
      vi.advanceTimersByTime(10000);

      const result = await resultPromise;

      expect(result).toBe(false);
      expect(fakeChild.kill).toHaveBeenCalled();
    });

    it('should not kill the process when CLI exits before timeout', async () => {
      vi.useFakeTimers();
      const { EventEmitter } = require('events');

      // Create a fake child process that exits quickly
      const fakeChild = new EventEmitter();
      fakeChild.stdout = new EventEmitter();
      fakeChild.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(fakeChild);

      const provider = new PiProvider('test-model');
      const resultPromise = provider.testAvailability();

      // Process exits successfully before timeout
      fakeChild.emit('close', 0);
      const result = await resultPromise;

      // Advance past timeout to confirm it was cleared
      vi.advanceTimersByTime(10000);

      expect(result).toBe(true);
      expect(fakeChild.kill).not.toHaveBeenCalled();
    });
  });

  describe('provider registration', () => {
    it('should be registered with the correct ID', () => {
      const { getProviderClass } = require('../../src/ai/provider');
      const RegisteredProvider = getProviderClass('pi');
      expect(RegisteredProvider).toBe(PiProvider);
    });

    it('should be listed in registered providers', () => {
      const { getRegisteredProviderIds } = require('../../src/ai/provider');
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('pi');
    });
  });
});
