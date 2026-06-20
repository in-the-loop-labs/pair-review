// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock logger
vi.mock('../../../src/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  section: vi.fn()
}));

// --- Patch the ai module via require.cache before chat-providers loads ---
const aiPath = require.resolve('../../../src/ai');
const originalAiExport = require(aiPath);
const mockGetCachedAvailability = vi.fn();
require.cache[aiPath].exports = {
  ...originalAiExport,
  getCachedAvailability: mockGetCachedAvailability,
};

// Now import chat-providers (it will use our patched ai module)
const {
  getChatProvider,
  getAllChatProviders,
  isAcpProvider,
  isClaudeCodeProvider,
  isCodexProvider,
  checkChatProviderAvailability,
  checkAllChatProviders,
  getCachedChatAvailability,
  getAllCachedChatAvailability,
  applyConfigOverrides,
  clearChatAvailabilityCache,
  clearConfigOverrides,
} = require('../../../src/chat/chat-providers');

describe('chat-providers', () => {
  afterAll(() => {
    require.cache[aiPath].exports = originalAiExport;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearChatAvailabilityCache();
    clearConfigOverrides();
  });

  describe('getChatProvider', () => {
    it('should return pi provider', () => {
      const pi = getChatProvider('pi');
      expect(pi).toEqual({ id: 'pi', name: 'Pi (RPC)', type: 'pi' });
    });

    it('should return copilot-acp provider with correct defaults', () => {
      const copilot = getChatProvider('copilot-acp');
      expect(copilot).toEqual({
        id: 'copilot-acp',
        name: 'Copilot (ACP)',
        type: 'acp',
        command: 'copilot',
        args: ['--acp', '--stdio'],
        env: {},
      });
    });

    it('should return gemini-acp provider with correct defaults', () => {
      const gemini = getChatProvider('gemini-acp');
      expect(gemini).toEqual({
        id: 'gemini-acp',
        name: 'Gemini (ACP)',
        type: 'acp',
        command: 'gemini',
        args: ['--experimental-acp'],
        env: {},
      });
    });

    it('should return opencode-acp provider with correct defaults', () => {
      const opencode = getChatProvider('opencode-acp');
      expect(opencode).toEqual({
        id: 'opencode-acp',
        name: 'OpenCode (ACP)',
        type: 'acp',
        command: 'opencode',
        args: ['acp'],
        env: {},
      });
    });

    it('should return cursor-acp provider with correct defaults', () => {
      const cursor = getChatProvider('cursor-acp');
      expect(cursor).toEqual({
        id: 'cursor-acp',
        name: 'Cursor (ACP)',
        type: 'acp',
        command: 'agent',
        args: ['acp'],
        env: {},
      });
    });

    it('should return null for unknown provider', () => {
      expect(getChatProvider('unknown')).toBeNull();
    });

    it('should return codex provider with chat-safe sandbox defaults', () => {
      const codex = getChatProvider('codex');
      expect(codex).toMatchObject({
        id: 'codex',
        name: 'Codex (JSON-RPC)',
        type: 'codex',
        command: 'codex',
        sandbox: 'workspace-write',
      });
      expect(codex.args).toContain('app-server');
    });

    it('should merge config overrides for command', () => {
      applyConfigOverrides({
        'copilot-acp': { command: '/usr/local/bin/copilot' },
      });
      const provider = getChatProvider('copilot-acp');
      expect(provider.command).toBe('/usr/local/bin/copilot');
      expect(provider.args).toEqual(['--acp', '--stdio']); // unchanged
    });

    it('should merge config overrides for args', () => {
      applyConfigOverrides({
        'gemini-acp': { args: ['--experimental-acp', '--verbose'] },
      });
      const provider = getChatProvider('gemini-acp');
      expect(provider.args).toEqual(['--experimental-acp', '--verbose']);
    });

    it('should append extra_args to existing args', () => {
      applyConfigOverrides({
        'copilot-acp': { extra_args: ['--verbose'] },
      });
      const provider = getChatProvider('copilot-acp');
      expect(provider.args).toEqual(['--acp', '--stdio', '--verbose']);
    });

    it('should merge codex sandbox override', () => {
      applyConfigOverrides({
        codex: {
          sandbox: 'read-only',
        },
      });
      const provider = getChatProvider('codex');
      expect(provider.sandbox).toBe('read-only');
    });

    it('should fall back to workspace-write for invalid codex sandbox override', () => {
      applyConfigOverrides({
        codex: { sandbox: 'danger-full-access' },
      });
      const provider = getChatProvider('codex');
      expect(provider.sandbox).toBe('workspace-write');
    });

    it('should merge config overrides for env', () => {
      applyConfigOverrides({
        'copilot-acp': { env: { CUSTOM_VAR: 'yes' } },
      });
      const provider = getChatProvider('copilot-acp');
      expect(provider.env).toEqual({ CUSTOM_VAR: 'yes' });
    });

    it('should not mutate other providers when overriding one', () => {
      applyConfigOverrides({
        'copilot-acp': { command: '/custom/copilot' },
      });
      const gemini = getChatProvider('gemini-acp');
      expect(gemini.command).toBe('gemini');
    });

    it('should set useShell true for multi-word commands', () => {
      applyConfigOverrides({
        'claude': { command: 'devx claude' },
      });
      const provider = getChatProvider('claude');
      expect(provider.command).toBe('devx claude');
      expect(provider.useShell).toBe(true);
    });

    it('should not set useShell for single-word commands', () => {
      applyConfigOverrides({
        'claude': { command: '/usr/local/bin/claude' },
      });
      const provider = getChatProvider('claude');
      expect(provider.useShell).toBeUndefined();
    });

    it('should merge config overrides for model', () => {
      applyConfigOverrides({
        'opencode-acp': { model: 'anthropic/claude-opus-4-6' },
      });
      const provider = getChatProvider('opencode-acp');
      expect(provider.model).toBe('anthropic/claude-opus-4-6');
    });

    it('should not set model when override is not provided', () => {
      applyConfigOverrides({
        'opencode-acp': { command: '/custom/opencode' },
      });
      const provider = getChatProvider('opencode-acp');
      expect(provider.model).toBeUndefined();
    });

    it('should merge config overrides for provider (model provider)', () => {
      applyConfigOverrides({
        'pi': { provider: 'google' },
      });
      const provider = getChatProvider('pi');
      expect(provider.provider).toBe('google');
    });

    it('should not set provider when override is not provided', () => {
      applyConfigOverrides({
        'pi': { model: 'gemini-2.5-flash' },
      });
      const provider = getChatProvider('pi');
      expect(provider.provider).toBeUndefined();
    });

    it('should forward provider field for dynamic (non-built-in) providers', () => {
      applyConfigOverrides({
        'river': { type: 'pi', command: 'my-pi', provider: 'google' },
      });
      const provider = getChatProvider('river');
      expect(provider.provider).toBe('google');
      expect(provider.type).toBe('pi');
      expect(provider.command).toBe('my-pi');
    });

    it('should pass through availability_command for dynamic providers', () => {
      applyConfigOverrides({
        'river': { type: 'pi', command: 'my-pi', availability_command: 'true' },
      });
      const provider = getChatProvider('river');
      expect(provider.availability_command).toBe('true');
    });

    it('should pass through availability_command from config overrides for built-in providers', () => {
      applyConfigOverrides({
        'pi': { availability_command: 'devx pi --version' },
      });
      const provider = getChatProvider('pi');
      expect(provider.availability_command).toBe('devx pi --version');
    });

    it('should pass through load_skills from config overrides for built-in providers', () => {
      applyConfigOverrides({
        'pi': { load_skills: false },
      });
      const provider = getChatProvider('pi');
      expect(provider.load_skills).toBe(false);
    });

    it('should pass through app_extensions from config overrides for built-in providers', () => {
      applyConfigOverrides({
        'pi': { app_extensions: false },
      });
      const provider = getChatProvider('pi');
      expect(provider.app_extensions).toBe(false);
    });

    it('should not set load_skills when not provided in overrides', () => {
      applyConfigOverrides({
        'pi': { command: '/custom/pi' },
      });
      const provider = getChatProvider('pi');
      expect(provider.load_skills).toBeUndefined();
    });

    it('should not set app_extensions when not provided in overrides', () => {
      applyConfigOverrides({
        'pi': { command: '/custom/pi' },
      });
      const provider = getChatProvider('pi');
      expect(provider.app_extensions).toBeUndefined();
    });

    it('should pass through load_skills and app_extensions for dynamic providers', () => {
      applyConfigOverrides({
        'river': { type: 'pi', command: 'my-pi', load_skills: false, app_extensions: false },
      });
      const provider = getChatProvider('river');
      expect(provider.load_skills).toBe(false);
      expect(provider.app_extensions).toBe(false);
    });

    it('should not set load_skills or app_extensions on dynamic providers when not configured', () => {
      applyConfigOverrides({
        'river': { type: 'pi', command: 'my-pi' },
      });
      const provider = getChatProvider('river');
      expect(provider.load_skills).toBeUndefined();
      expect(provider.app_extensions).toBeUndefined();
    });
  });

  describe('getAllChatProviders', () => {
    it('should return all seven providers', () => {
      const providers = getAllChatProviders();
      expect(providers).toHaveLength(7);
      const ids = providers.map(p => p.id);
      expect(ids).toContain('pi');
      expect(ids).toContain('copilot-acp');
      expect(ids).toContain('gemini-acp');
      expect(ids).toContain('opencode-acp');
      expect(ids).toContain('cursor-acp');
      expect(ids).toContain('claude');
      expect(ids).toContain('codex');
    });

    it('should return copies with overrides applied', () => {
      applyConfigOverrides({
        'copilot-acp': { command: '/custom' },
      });
      const providers = getAllChatProviders();
      const copilot = providers.find(p => p.id === 'copilot-acp');
      expect(copilot.command).toBe('/custom');
    });
  });

  describe('isAcpProvider', () => {
    it('should return false for pi', () => {
      expect(isAcpProvider('pi')).toBe(false);
    });

    it('should return true for copilot-acp', () => {
      expect(isAcpProvider('copilot-acp')).toBe(true);
    });

    it('should return true for gemini-acp', () => {
      expect(isAcpProvider('gemini-acp')).toBe(true);
    });

    it('should return true for opencode-acp', () => {
      expect(isAcpProvider('opencode-acp')).toBe(true);
    });

    it('should return true for cursor-acp', () => {
      expect(isAcpProvider('cursor-acp')).toBe(true);
    });

    it('should return false for unknown provider', () => {
      expect(isAcpProvider('unknown')).toBe(false);
    });

    it('should return false for claude', () => {
      expect(isAcpProvider('claude')).toBe(false);
    });

    it('should return false for codex', () => {
      expect(isAcpProvider('codex')).toBe(false);
    });
  });

  describe('isClaudeCodeProvider', () => {
    it('should return true for claude', () => {
      expect(isClaudeCodeProvider('claude')).toBe(true);
    });

    it('should return false for pi', () => {
      expect(isClaudeCodeProvider('pi')).toBe(false);
    });

    it('should return false for ACP providers', () => {
      expect(isClaudeCodeProvider('copilot-acp')).toBe(false);
      expect(isClaudeCodeProvider('gemini-acp')).toBe(false);
    });

    it('should return false for unknown provider', () => {
      expect(isClaudeCodeProvider('unknown')).toBe(false);
    });
  });

  describe('isCodexProvider', () => {
    it('should return true for codex', () => {
      expect(isCodexProvider('codex')).toBe(true);
    });

    it('should return false for pi', () => {
      expect(isCodexProvider('pi')).toBe(false);
    });

    it('should return false for ACP providers', () => {
      expect(isCodexProvider('copilot-acp')).toBe(false);
    });

    it('should return false for unknown provider', () => {
      expect(isCodexProvider('unknown')).toBe(false);
    });
  });

  describe('checkChatProviderAvailability', () => {
    it('should delegate to getCachedAvailability for pi', async () => {
      mockGetCachedAvailability.mockReturnValue({ available: true });
      const result = await checkChatProviderAvailability('pi');
      expect(result).toEqual({ available: true, error: undefined });
      expect(mockGetCachedAvailability).toHaveBeenCalledWith('pi');
    });

    it('should return unavailable for pi when getCachedAvailability returns null', async () => {
      mockGetCachedAvailability.mockReturnValue(null);
      const result = await checkChatProviderAvailability('pi');
      expect(result).toEqual({ available: false, error: undefined });
    });

    it('does not consult the pi cache for a custom type:pi provider with its own command', async () => {
      // A custom type:'pi' provider points at a different binary than the
      // AI-provider's pi, so the cached AI-provider status would be a wrong
      // answer. It must run its own probe and respect its configured timeout.
      applyConfigOverrides({
        'river': { type: 'pi', command: '/bin/false', availability_timeout_seconds: 5 },
      });
      mockGetCachedAvailability.mockReturnValue({ available: true });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('river', { spawn: mockSpawn });
      fakeProc.emit('close', 1);

      const result = await promise;
      expect(result.available).toBe(false);
      expect(mockGetCachedAvailability).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith(
        '/bin/false', ['--version'], expect.objectContaining({ timeout: 5000 })
      );
    });

    it('does not consult the pi cache when built-in pi is overridden with a command', async () => {
      applyConfigOverrides({ 'pi': { command: '/opt/pi' } });
      mockGetCachedAvailability.mockReturnValue({ available: true });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('pi', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockGetCachedAvailability).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith('/opt/pi', ['--version'], expect.any(Object));
    });

    it('should return unavailable for unknown provider', async () => {
      const result = await checkChatProviderAvailability('unknown');
      expect(result).toEqual({ available: false, error: 'Unknown provider: unknown' });
    });

    it('should resolve available when spawn exits with code 0', async () => {
      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('copilot-acp', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockSpawn).toHaveBeenCalledWith('copilot', ['--version'], expect.any(Object));
    });

    it('should resolve unavailable when spawn exits with non-zero code', async () => {
      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('gemini-acp', { spawn: mockSpawn });
      fakeProc.emit('close', 1);

      const result = await promise;
      expect(result.available).toBe(false);
      expect(result.error).toContain('exited with code 1');
    });

    it('should resolve unavailable on spawn error (e.g. ENOENT)', async () => {
      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('opencode-acp', { spawn: mockSpawn });
      fakeProc.emit('error', new Error('ENOENT'));

      const result = await promise;
      expect(result).toEqual({ available: false, error: 'ENOENT' });
    });

    it('should use config-overridden command for version check', async () => {
      applyConfigOverrides({
        'copilot-acp': { command: '/custom/copilot' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('copilot-acp', { spawn: mockSpawn });
      fakeProc.emit('close', 0);
      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('/custom/copilot', ['--version'], expect.any(Object));
    });

    it('should use shell mode for multi-word commands', async () => {
      applyConfigOverrides({
        'claude': { command: 'devx claude' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('claude', { spawn: mockSpawn });
      fakeProc.emit('close', 0);
      await promise;

      // With shell mode, command is joined with args
      expect(mockSpawn).toHaveBeenCalledWith('devx claude --version', [], expect.objectContaining({ shell: true }));
    });

    it('should use availability_command for dynamic providers', async () => {
      applyConfigOverrides({
        'custom-chat': { command: 'custom-chat', availability_command: 'true' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockSpawn).toHaveBeenCalledWith('true', [], expect.objectContaining({ shell: true, timeout: 10000 }));
    });

    it('should not consult cached generic pi availability for pi-typed dynamic providers with availability_command', async () => {
      applyConfigOverrides({
        'river-local': { type: 'pi', command: 'tec run //system/river/agent --', availability_command: 'true' },
      });
      mockGetCachedAvailability.mockReturnValue({ available: false, error: 'generic pi unavailable' });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('river-local', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockGetCachedAvailability).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith('true', [], expect.objectContaining({ shell: true }));
    });

    it('should use availability_command from built-in provider overrides', async () => {
      applyConfigOverrides({
        'claude': { availability_command: 'devx claude doctor' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('claude', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockSpawn).toHaveBeenCalledWith('devx claude doctor', [], expect.objectContaining({ shell: true }));
    });

    it('should return unavailable when availability_command exits non-zero', async () => {
      applyConfigOverrides({
        'custom-chat': { command: 'custom-chat', availability_command: 'false' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 1);

      const result = await promise;
      expect(result.available).toBe(false);
      expect(result.error).toContain('availability command exited with code 1');
      expect(result.error).not.toContain('false');
    });

    it('should return unavailable when availability_command spawn errors', async () => {
      applyConfigOverrides({
        'custom-chat': { command: 'custom-chat', availability_command: 'custom doctor' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('error', new Error('spawn failed'));

      const result = await promise;
      expect(result).toEqual({ available: false, error: 'spawn failed' });
    });

    it('should return unavailable when availability_command times out', async () => {
      applyConfigOverrides({
        'custom-chat': { command: 'custom-chat', availability_command: 'sleep 30' },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', null, 'SIGTERM');

      const result = await promise;
      expect(result.available).toBe(false);
      expect(result.error).toContain('availability command timed out or was terminated (SIGTERM)');
      expect(result.error).not.toContain('sleep 30');
      expect(mockSpawn).toHaveBeenCalledWith('sleep 30', [], expect.objectContaining({ timeout: 10000 }));
    });

    it('passes availability_timeout_seconds through to getChatProvider', () => {
      applyConfigOverrides({
        'custom-chat': { command: 'custom-chat', availability_timeout_seconds: 45 },
      });
      expect(getChatProvider('custom-chat').availability_timeout_seconds).toBe(45);
    });

    it('uses configured availability_timeout_seconds for the availability_command spawn timeout', async () => {
      applyConfigOverrides({
        'custom-chat': {
          command: 'custom-chat',
          availability_command: 'slow-build',
          availability_timeout_seconds: 30,
        },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockSpawn).toHaveBeenCalledWith('slow-build', [], expect.objectContaining({ timeout: 30000 }));
    });

    it('uses configured availability_timeout_seconds for the --version fallback spawn timeout', async () => {
      applyConfigOverrides({
        'custom-chat': { command: 'custom-chat', availability_timeout_seconds: 25 },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      const result = await promise;
      expect(result).toEqual({ available: true });
      expect(mockSpawn).toHaveBeenCalledWith('custom-chat', ['--version'], expect.objectContaining({ timeout: 25000 }));
    });

    it('falls back to 10s when availability_timeout_seconds is invalid', async () => {
      applyConfigOverrides({
        'custom-chat': {
          command: 'custom-chat',
          availability_command: 'true',
          availability_timeout_seconds: 0,
        },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 0);

      await promise;
      expect(mockSpawn).toHaveBeenCalledWith('true', [], expect.objectContaining({ timeout: 10000 }));
    });

    it('should merge provider.env over process.env when running availability_command', async () => {
      applyConfigOverrides({
        'custom-chat': {
          command: 'custom-chat',
          availability_command: 'true',
          env: { CUSTOM_VAR: 'value' },
        },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 0);
      await promise;

      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env).toMatchObject({
        ...process.env,
        CUSTOM_VAR: 'value',
      });
    });

    it('should merge provider.env over process.env when running --version probe', async () => {
      applyConfigOverrides({
        'copilot-acp': { env: { CUSTOM_VAR: 'value' } },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('copilot-acp', { spawn: mockSpawn });
      fakeProc.emit('close', 0);
      await promise;

      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env).toMatchObject({
        ...process.env,
        CUSTOM_VAR: 'value',
      });
    });

    it('should pass merged env including parent process env and provider env override to availability_command spawn', async () => {
      applyConfigOverrides({
        'custom-chat': {
          command: 'custom-chat',
          availability_command: 'true',
          env: { CUSTOM_API_KEY: 'secret' },
        },
      });

      const { EventEmitter } = require('events');
      const fakeProc = new EventEmitter();
      const mockSpawn = vi.fn().mockReturnValue(fakeProc);

      const promise = checkChatProviderAvailability('custom-chat', { spawn: mockSpawn });
      fakeProc.emit('close', 0);
      await promise;

      const spawnOpts = mockSpawn.mock.calls[0][2];
      expect(spawnOpts.env).toMatchObject({
        ...process.env,
        CUSTOM_API_KEY: 'secret',
      });
    });
  });

  describe('checkAllChatProviders', () => {
    it('should populate cache for all providers', async () => {
      mockGetCachedAvailability.mockReturnValue({ available: true });

      const { EventEmitter } = require('events');
      const mockSpawn = vi.fn().mockImplementation(() => {
        const proc = new EventEmitter();
        setTimeout(() => proc.emit('close', 0), 0);
        return proc;
      });

      await checkAllChatProviders({ spawn: mockSpawn });

      const cache = getAllCachedChatAvailability();
      expect(cache.pi).toEqual({ available: true, error: undefined });
      expect(cache['copilot-acp']).toEqual({ available: true });
      expect(cache['gemini-acp']).toEqual({ available: true });
      expect(cache['opencode-acp']).toEqual({ available: true });
      expect(cache['cursor-acp']).toEqual({ available: true });
      expect(cache['claude']).toEqual({ available: true });
      expect(cache.codex).toEqual({ available: true });
    });
  });

  describe('cache operations', () => {
    it('should return null for uncached provider', () => {
      expect(getCachedChatAvailability('copilot-acp')).toBeNull();
    });

    it('should return cached result after checkAllChatProviders', async () => {
      mockGetCachedAvailability.mockReturnValue({ available: false, error: 'not found' });

      const { EventEmitter } = require('events');
      const mockSpawn = vi.fn().mockImplementation(() => {
        const proc = new EventEmitter();
        setTimeout(() => proc.emit('close', 0), 0);
        return proc;
      });

      await checkAllChatProviders({ spawn: mockSpawn });

      const piResult = getCachedChatAvailability('pi');
      expect(piResult.available).toBe(false);

      const copilotResult = getCachedChatAvailability('copilot-acp');
      expect(copilotResult.available).toBe(true);
    });

    it('should clear cache', async () => {
      mockGetCachedAvailability.mockReturnValue({ available: true });
      const { EventEmitter } = require('events');
      const mockSpawn = vi.fn().mockImplementation(() => {
        const proc = new EventEmitter();
        setTimeout(() => proc.emit('close', 0), 0);
        return proc;
      });

      await checkAllChatProviders({ spawn: mockSpawn });
      expect(getCachedChatAvailability('copilot-acp')).not.toBeNull();

      clearChatAvailabilityCache();
      expect(getCachedChatAvailability('copilot-acp')).toBeNull();
    });

    it('should return empty object from getAllCachedChatAvailability when cache is empty', () => {
      expect(getAllCachedChatAvailability()).toEqual({});
    });
  });
});
