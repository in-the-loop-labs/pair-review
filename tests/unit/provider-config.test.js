// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for provider configuration system
 *
 * Tests the config override functionality including:
 * - Model inference (prettifyModelId, inferModelDefaults)
 * - Default model resolution (resolveDefaultModel)
 * - Config override application (applyConfigOverrides)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  prettifyModelId,
  inferModelDefaults,
  resolveDefaultModel,
  applyConfigOverrides,
  getProviderConfigOverrides,
  getAllProvidersInfo,
  getRegisteredProviderIds,
  createProvider
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

  describe('model merging (built-in + config)', () => {
    // Pi has built-in models ('default', 'multi-model'), making it ideal for
    // testing the mergeModels behavior that combines built-ins with config overrides.

    beforeEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    it('should return built-in models when no config models provided', () => {
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      expect(pi).toBeDefined();
      expect(pi.models.length).toBeGreaterThanOrEqual(2);
      expect(pi.models.find(m => m.id === 'default')).toBeDefined();
      expect(pi.models.find(m => m.id === 'multi-model')).toBeDefined();
    });

    it('should append config models with new IDs to built-ins', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'gemini-2.5-flash', tier: 'fast' }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      // Built-ins preserved + new config model appended
      expect(pi.models.find(m => m.id === 'default')).toBeDefined();
      expect(pi.models.find(m => m.id === 'multi-model')).toBeDefined();
      expect(pi.models.find(m => m.id === 'gemini-2.5-flash')).toBeDefined();
    });

    it('should replace built-in model when config model has same ID', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'default', tier: 'fast', name: 'Custom Default', default: true }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      const defaultModel = pi.models.find(m => m.id === 'default');
      expect(defaultModel).toBeDefined();
      expect(defaultModel.name).toBe('Custom Default');
      expect(defaultModel.tier).toBe('fast');
      // multi-model should still exist (not overridden)
      expect(pi.models.find(m => m.id === 'multi-model')).toBeDefined();
    });

    it('should handle mix of overriding and new config models', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'default', tier: 'thorough', name: 'Overridden Default' },
              { id: 'gemini-2.5-pro', tier: 'thorough' }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      // 'default' replaced, 'multi-model' retained, 'gemini-2.5-pro' added
      const defaultModel = pi.models.find(m => m.id === 'default');
      expect(defaultModel.name).toBe('Overridden Default');
      expect(pi.models.find(m => m.id === 'multi-model')).toBeDefined();
      expect(pi.models.find(m => m.id === 'gemini-2.5-pro')).toBeDefined();
    });

    it('should return built-ins unchanged when config models is empty array', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: []
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      // Empty array is treated as "no overrides" by applyConfigOverrides
      expect(pi.models.find(m => m.id === 'default')).toBeDefined();
      expect(pi.models.find(m => m.id === 'multi-model')).toBeDefined();
    });

    it('should resolve default from merged models in createProvider', () => {
      // Pi built-in 'default' model has default:true
      // Adding a config model should not break default resolution
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'gemini-2.5-flash', tier: 'fast' }
            ]
          }
        }
      });
      const provider = createProvider('pi');

      // Should still resolve to 'default' (built-in with default:true)
      expect(provider.model).toBe('default');
    });

    it('should resolve default from config model when it has default:true', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'gemini-2.5-flash', tier: 'fast', default: true }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      // Config model with default:true AND built-in 'default' with default:true
      // resolveDefaultModel picks the first one with default:true
      // Built-ins come first in merged list, so built-in 'default' wins
      expect(pi.defaultModel).toBe('default');
    });

    it('should preserve tiers for built-in models alongside config models', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'gemini-2.5-flash', tier: 'fast' }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      // Built-in model tiers should still be present
      expect(pi.models.find(m => m.id === 'default').tier).toBe('balanced');
      expect(pi.models.find(m => m.id === 'multi-model').tier).toBe('thorough');
      // Config model tier should also work
      expect(pi.models.find(m => m.id === 'gemini-2.5-flash').tier).toBe('fast');
    });

    it('should not include unknown models after merge', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'gemini-2.5-flash', tier: 'fast' }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      expect(pi.models.find(m => m.id === 'nonexistent-model')).toBeUndefined();
    });

    it('should use overridden tier when config replaces built-in model', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            models: [
              { id: 'default', tier: 'thorough' }
            ]
          }
        }
      });
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');

      // 'default' was balanced in built-in, now overridden to thorough
      expect(pi.models.find(m => m.id === 'default').tier).toBe('thorough');
      // 'multi-model' should be unaffected
      expect(pi.models.find(m => m.id === 'multi-model').tier).toBe('thorough');
    });
  });

  describe('yolo mode propagation', () => {
    let savedYoloEnv;

    beforeEach(() => {
      savedYoloEnv = process.env.PAIR_REVIEW_YOLO;
      delete process.env.PAIR_REVIEW_YOLO;
      // Clear any existing overrides
      applyConfigOverrides({ providers: {} });
    });

    afterEach(() => {
      // Restore env var
      if (savedYoloEnv === undefined) {
        delete process.env.PAIR_REVIEW_YOLO;
      } else {
        process.env.PAIR_REVIEW_YOLO = savedYoloEnv;
      }
      // Reset yolo mode
      applyConfigOverrides({ providers: {} });
    });

    it('should set yolo mode from config', () => {
      applyConfigOverrides({ yolo: true, providers: {} });
      const provider = createProvider('claude');

      expect(provider.args).toContain('--dangerously-skip-permissions');
      expect(provider.args).not.toContain('--allowedTools');
    });

    it('should set yolo mode from env var', () => {
      process.env.PAIR_REVIEW_YOLO = 'true';
      applyConfigOverrides({ providers: {} });
      const provider = createProvider('claude');

      expect(provider.args).toContain('--dangerously-skip-permissions');
      expect(provider.args).not.toContain('--allowedTools');
    });

    it('should default yolo mode to false', () => {
      applyConfigOverrides({ providers: {} });
      const provider = createProvider('claude');

      expect(provider.args).toContain('--allowedTools');
      expect(provider.args).not.toContain('--dangerously-skip-permissions');
    });

    it('should not enable yolo when env var is "false"', () => {
      process.env.PAIR_REVIEW_YOLO = 'false';
      applyConfigOverrides({ providers: {} });
      const provider = createProvider('claude');

      expect(provider.args).toContain('--allowedTools');
      expect(provider.args).not.toContain('--dangerously-skip-permissions');
    });
  });
});
