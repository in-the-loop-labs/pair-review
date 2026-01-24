// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for provider configuration system
 *
 * Tests the config override functionality including:
 * - Model inference (prettifyModelId, inferModelDefaults)
 * - Default model resolution (resolveDefaultModel)
 * - Config override application (applyConfigOverrides)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  prettifyModelId,
  inferModelDefaults,
  resolveDefaultModel,
  applyConfigOverrides,
  getProviderConfigOverrides,
  getAllProvidersInfo,
  getRegisteredProviderIds
} from '../../src/ai/index.js';

describe('Provider Configuration', () => {
  describe('prettifyModelId', () => {
    it('should convert slashes to spaces and capitalize', () => {
      expect(prettifyModelId('anthropic/claude-sonnet-4')).toBe('Anthropic Claude Sonnet 4');
    });

    it('should convert hyphens to spaces and capitalize', () => {
      expect(prettifyModelId('gpt-5.1-codex-mini')).toBe('Gpt 5.1 Codex Mini');
    });

    it('should handle simple model ids', () => {
      expect(prettifyModelId('sonnet')).toBe('Sonnet');
    });

    it('should handle model ids with numbers', () => {
      expect(prettifyModelId('gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    });
  });

  describe('inferModelDefaults', () => {
    it('should infer name from id when not provided', () => {
      const model = { id: 'anthropic/claude-sonnet-4', tier: 'balanced' };
      const result = inferModelDefaults(model);

      expect(result.name).toBe('Anthropic Claude Sonnet 4');
    });

    it('should preserve name when provided', () => {
      const model = { id: 'anthropic/claude-sonnet-4', tier: 'balanced', name: 'Claude Sonnet 4' };
      const result = inferModelDefaults(model);

      expect(result.name).toBe('Claude Sonnet 4');
    });

    it('should infer badge from fast tier', () => {
      const model = { id: 'test-model', tier: 'fast' };
      const result = inferModelDefaults(model);

      expect(result.badge).toBe('Fastest');
      expect(result.badgeClass).toBe('badge-speed');
    });

    it('should infer badge from balanced tier', () => {
      const model = { id: 'test-model', tier: 'balanced' };
      const result = inferModelDefaults(model);

      expect(result.badge).toBe('Recommended');
      expect(result.badgeClass).toBe('badge-recommended');
    });

    it('should infer badge from thorough tier', () => {
      const model = { id: 'test-model', tier: 'thorough' };
      const result = inferModelDefaults(model);

      expect(result.badge).toBe('Most Thorough');
      expect(result.badgeClass).toBe('badge-power');
    });

    it('should treat premium as alias for thorough tier', () => {
      const model = { id: 'test-model', tier: 'premium' };
      const result = inferModelDefaults(model);

      // Premium is an alias for thorough, so gets thorough's defaults
      expect(result.badge).toBe('Most Thorough');
      expect(result.badgeClass).toBe('badge-power');
    });

    it('should treat free as alias for fast tier', () => {
      const model = { id: 'test-model', tier: 'free' };
      const result = inferModelDefaults(model);

      // Free is an alias for fast, so gets fast's defaults
      expect(result.badge).toBe('Fastest');
      expect(result.badgeClass).toBe('badge-speed');
    });

    it('should preserve custom badge when provided', () => {
      const model = { id: 'test-model', tier: 'fast', badge: 'Custom Badge' };
      const result = inferModelDefaults(model);

      expect(result.badge).toBe('Custom Badge');
    });

    it('should throw error for missing tier', () => {
      const model = { id: 'test-model' };

      expect(() => inferModelDefaults(model)).toThrow('missing required "tier" field');
    });

    it('should throw error for invalid tier', () => {
      const model = { id: 'test-model', tier: 'unknown-tier' };

      expect(() => inferModelDefaults(model)).toThrow('invalid tier "unknown-tier"');
    });

    it('should set empty strings for missing tagline and description', () => {
      const model = { id: 'test-model', tier: 'balanced' };
      const result = inferModelDefaults(model);

      expect(result.tagline).toBe('');
      expect(result.description).toBe('');
    });

    it('should preserve tagline and description when provided', () => {
      const model = {
        id: 'test-model',
        tier: 'balanced',
        tagline: 'My Tagline',
        description: 'My Description'
      };
      const result = inferModelDefaults(model);

      expect(result.tagline).toBe('My Tagline');
      expect(result.description).toBe('My Description');
    });
  });

  describe('resolveDefaultModel', () => {
    it('should return model with default: true', () => {
      const models = [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'balanced', default: true },
        { id: 'model-c', tier: 'thorough' }
      ];

      expect(resolveDefaultModel(models)).toBe('model-b');
    });

    it('should fall back to first balanced tier model when no default', () => {
      const models = [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'balanced' },
        { id: 'model-c', tier: 'thorough' }
      ];

      expect(resolveDefaultModel(models)).toBe('model-b');
    });

    it('should fall back to first model when no balanced tier', () => {
      const models = [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'thorough' }
      ];

      expect(resolveDefaultModel(models)).toBe('model-a');
    });

    it('should return null for empty array', () => {
      expect(resolveDefaultModel([])).toBe(null);
    });

    it('should return null for null input', () => {
      expect(resolveDefaultModel(null)).toBe(null);
    });

    it('should return null for undefined input', () => {
      expect(resolveDefaultModel(undefined)).toBe(null);
    });

    it('should prefer explicit default over balanced tier', () => {
      const models = [
        { id: 'model-a', tier: 'fast', default: true },
        { id: 'model-b', tier: 'balanced' }
      ];

      expect(resolveDefaultModel(models)).toBe('model-a');
    });
  });

  describe('applyConfigOverrides', () => {
    beforeEach(() => {
      // Clear any existing overrides by applying empty config
      applyConfigOverrides({ providers: {} });
    });

    it('should apply config overrides for a provider', () => {
      const config = {
        providers: {
          opencode: {
            command: '/custom/opencode',
            extra_args: ['--verbose'],
            env: { OPENCODE_API_KEY: 'test-key' },
            models: [
              { id: 'test-model', tier: 'balanced', default: true }
            ]
          }
        }
      };

      applyConfigOverrides(config);
      const overrides = getProviderConfigOverrides('opencode');

      expect(overrides).toBeDefined();
      expect(overrides.command).toBe('/custom/opencode');
      expect(overrides.extra_args).toEqual(['--verbose']);
      expect(overrides.env).toEqual({ OPENCODE_API_KEY: 'test-key' });
      expect(overrides.models).toHaveLength(1);
      expect(overrides.models[0].id).toBe('test-model');
    });

    it('should process models through inferModelDefaults', () => {
      const config = {
        providers: {
          opencode: {
            models: [
              { id: 'anthropic/claude-sonnet-4', tier: 'balanced' }
            ]
          }
        }
      };

      applyConfigOverrides(config);
      const overrides = getProviderConfigOverrides('opencode');

      expect(overrides.models[0].name).toBe('Anthropic Claude Sonnet 4');
      expect(overrides.models[0].badge).toBe('Recommended');
      expect(overrides.models[0].badgeClass).toBe('badge-recommended');
    });

    it('should return undefined for non-configured provider', () => {
      applyConfigOverrides({ providers: {} });
      const overrides = getProviderConfigOverrides('non-existent');

      expect(overrides).toBeUndefined();
    });

    it('should handle empty providers config', () => {
      applyConfigOverrides({});

      // Should not throw
      const overrides = getProviderConfigOverrides('claude');
      expect(overrides).toBeUndefined();
    });
  });

  describe('getAllProvidersInfo with overrides', () => {
    beforeEach(() => {
      // Clear any existing overrides
      applyConfigOverrides({ providers: {} });
    });

    it('should include opencode in registered providers', () => {
      const providerIds = getRegisteredProviderIds();
      expect(providerIds).toContain('opencode');
    });

    it('should return empty models for opencode by default', () => {
      const providers = getAllProvidersInfo();
      const opencode = providers.find(p => p.id === 'opencode');

      expect(opencode).toBeDefined();
      expect(opencode.models).toEqual([]);
      expect(opencode.defaultModel).toBe(null);
    });

    it('should use overridden models for provider', () => {
      const config = {
        providers: {
          opencode: {
            models: [
              { id: 'test-model-1', tier: 'fast' },
              { id: 'test-model-2', tier: 'balanced', default: true },
              { id: 'test-model-3', tier: 'thorough' }
            ]
          }
        }
      };

      applyConfigOverrides(config);
      const providers = getAllProvidersInfo();
      const opencode = providers.find(p => p.id === 'opencode');

      expect(opencode.models).toHaveLength(3);
      expect(opencode.defaultModel).toBe('test-model-2');
    });

    it('should use overridden installInstructions', () => {
      const config = {
        providers: {
          opencode: {
            installInstructions: 'Custom install instructions'
          }
        }
      };

      applyConfigOverrides(config);
      const providers = getAllProvidersInfo();
      const opencode = providers.find(p => p.id === 'opencode');

      expect(opencode.installInstructions).toBe('Custom install instructions');
    });
  });
});
