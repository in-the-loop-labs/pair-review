// SPDX-License-Identifier: GPL-3.0-or-later
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
      expect(pi).toEqual({ id: 'pi', name: 'Pi', type: 'pi' });
    });

    it('should return copilot-acp provider with correct defaults', () => {
      const copilot = getChatProvider('copilot-acp');
      expect(copilot).toEqual({
        id: 'copilot-acp',
        name: 'Copilot',
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
        name: 'Gemini',
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
        name: 'OpenCode',
        type: 'acp',
        command: 'opencode',
        args: ['acp'],
        env: {},
      });
    });

    it('should return null for unknown provider', () => {
      expect(getChatProvider('unknown')).toBeNull();
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
  });

  describe('getAllChatProviders', () => {
    it('should return all four providers', () => {
      const providers = getAllChatProviders();
      expect(providers).toHaveLength(4);
      const ids = providers.map(p => p.id);
      expect(ids).toContain('pi');
      expect(ids).toContain('copilot-acp');
      expect(ids).toContain('gemini-acp');
      expect(ids).toContain('opencode-acp');
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

    it('should return false for unknown provider', () => {
      expect(isAcpProvider('unknown')).toBe(false);
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
