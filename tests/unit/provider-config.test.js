// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for provider configuration system
 *
 * Tests the config override functionality including:
 * - Model inference (prettifyModelId, inferModelDefaults)
 * - Default model resolution (resolveDefaultModel)
 * - Config override application (applyConfigOverrides)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// NOTE: production code (src/ai/provider.js) loads the logger via CommonJS
// `require('../utils/logger')`. Under vitest the ESM `import` of this CJS
// singleton resolves to a DIFFERENT instance than `require`, so a spy on the
// imported binding would never see production's calls. Spy on the require'd
// instance instead (matches the pattern in github-client.test.js).
const logger = require('../../src/utils/logger');
import {
  prettifyModelId,
  inferModelDefaults,
  resolveDefaultModel,
  applyConfigOverrides,
  getProviderConfigOverrides,
  getAllProvidersInfo,
  applyModelOverrides,
  normalizeDisabledModels,
  getRegisteredProviderIds,
  getProviderClass,
  createProvider,
  createAliasedProviderClass,
  getTierForModel,
  resolveAvailabilityTimeoutMs,
  secondsToTimeoutMs,
  DEFAULT_AVAILABILITY_TIMEOUT_MS
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

    it('should honor preferredId (default_model) over legacy default:true', () => {
      const models = [
        { id: 'model-a', tier: 'fast', default: true },
        { id: 'model-b', tier: 'balanced' },
        { id: 'model-c', tier: 'thorough' }
      ];

      expect(resolveDefaultModel(models, 'model-c')).toBe('model-c');
    });

    it('should fall through to legacy default:true when preferredId is not present', () => {
      const models = [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'balanced', default: true }
      ];

      // preferredId names a model that was disabled/removed → fall through
      expect(resolveDefaultModel(models, 'model-disabled')).toBe('model-b');
    });

    it('should fall through to automatic selection when preferredId is absent and no default:true', () => {
      const models = [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'balanced' }
      ];

      expect(resolveDefaultModel(models, 'nope')).toBe('model-b');
    });

    it('should ignore a null/undefined preferredId', () => {
      const models = [
        { id: 'model-a', tier: 'fast' },
        { id: 'model-b', tier: 'balanced', default: true }
      ];

      expect(resolveDefaultModel(models, null)).toBe('model-b');
      expect(resolveDefaultModel(models, undefined)).toBe('model-b');
    });

    it('should resolve a preferredId that names an alias to the canonical id', () => {
      const models = [
        { id: 'opus-4.8-xhigh', aliases: ['opus'], tier: 'thorough' },
        { id: 'sonnet-4.6', tier: 'balanced' }
      ];

      // preferredId 'opus' is an alias → resolves to canonical 'opus-4.8-xhigh'
      expect(resolveDefaultModel(models, 'opus')).toBe('opus-4.8-xhigh');
    });
  });

  describe('getTierForModel', () => {
    beforeEach(() => {
      // Clear any existing overrides so built-in model definitions are used
      applyConfigOverrides({ providers: {} });
    });

    it('should resolve tier by canonical model id', () => {
      expect(getTierForModel('codex', 'gpt-5.4-high')).toBe('thorough');
    });

    it('should resolve tier via aliases for legacy model ids', () => {
      // Regression: `gpt-5.4` was the pre-migration model ID stored in the
      // analysis_runs table before reasoning-effort variants existed.
      // It must keep resolving to 'thorough' via the alias on `gpt-5.4-high`
      // so historical runs get their tier backfilled correctly.
      expect(getTierForModel('codex', 'gpt-5.4')).toBe('thorough');
    });

    it('should return null for unknown models', () => {
      expect(getTierForModel('codex', 'completely-unknown-model')).toBeNull();
    });

    it('should return null for unknown providers', () => {
      expect(getTierForModel('nonexistent-provider', 'any-model')).toBeNull();
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

    it('should store load_skills and app_extensions in overrides for standard providers', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            load_skills: false,
            app_extensions: false
          }
        }
      });
      const overrides = getProviderConfigOverrides('pi');
      expect(overrides).toBeDefined();
      expect(overrides.load_skills).toBe(false);
      expect(overrides.app_extensions).toBe(false);
    });

    it('should store load_skills and app_extensions for alias providers', () => {
      applyConfigOverrides({
        providers: {
          'pi-custom': {
            type: 'pi',
            name: 'Custom Pi',
            load_skills: false,
            app_extensions: false,
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });
      const overrides = getProviderConfigOverrides('pi-custom');
      expect(overrides).toBeDefined();
      expect(overrides.load_skills).toBe(false);
      expect(overrides.app_extensions).toBe(false);
    });

    it('should leave load_skills and app_extensions undefined when not set in config', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            command: '/custom/pi'
          }
        }
      });
      const overrides = getProviderConfigOverrides('pi');
      expect(overrides).toBeDefined();
      expect(overrides.load_skills).toBeUndefined();
      expect(overrides.app_extensions).toBeUndefined();
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

    it('should give built-in providers default capabilities', () => {
      const providers = getAllProvidersInfo();
      const claude = providers.find(p => p.id === 'claude');

      expect(claude).toBeDefined();
      expect(claude.capabilities).toEqual({
        review_levels: true,
        custom_instructions: true,
        exclude_previous: true,
        consolidation: true
      });
    });

    it('should surface configured capabilities for executable providers', () => {
      applyConfigOverrides({
        providers: {
          'my-tool': {
            type: 'executable',
            command: '/usr/bin/my-tool',
            capabilities: {
              review_levels: true,
              custom_instructions: false
            },
            models: [
              { id: 'default', tier: 'balanced', default: true }
            ]
          }
        }
      });

      const providers = getAllProvidersInfo();
      const myTool = providers.find(p => p.id === 'my-tool');

      expect(myTool).toBeDefined();
      expect(myTool.capabilities).toEqual({
        review_levels: true,
        custom_instructions: false,
        exclude_previous: false,
        consolidation: false
      });
    });

    it('should default executable provider capabilities to false when not configured', () => {
      applyConfigOverrides({
        providers: {
          'bare-tool': {
            type: 'executable',
            command: '/usr/bin/bare-tool',
            models: [
              { id: 'default', tier: 'balanced', default: true }
            ]
          }
        }
      });

      const providers = getAllProvidersInfo();
      const bareTool = providers.find(p => p.id === 'bare-tool');

      expect(bareTool).toBeDefined();
      expect(bareTool.capabilities).toEqual({
        review_levels: false,
        custom_instructions: false,
        exclude_previous: false,
        consolidation: false
      });
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

    it('should replace a built-in model when a config model names its alias', () => {
      // The canonical built-in id is 'opus-4.8-xhigh' (aliased by 'opus').
      // A config override keyed to the alias must REPLACE the built-in (keeping
      // the canonical id) rather than append a duplicate.
      const before = getAllProvidersInfo().find(p => p.id === 'claude').models.length;
      applyConfigOverrides({
        providers: {
          claude: {
            models: [
              { id: 'opus', tier: 'thorough', cli_model: 'custom-x', name: 'Custom Opus' }
            ]
          }
        }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');

      // No standalone 'opus' id leaked in; the canonical entry persists
      expect(claude.models.find(m => m.id === 'opus')).toBeUndefined();
      const canonical = claude.models.find(m => m.id === 'opus-4.8-xhigh');
      expect(canonical).toBeDefined();
      // The override is reflected on the canonical entry
      expect(canonical.cli_model).toBe('custom-x');
      expect(canonical.name).toBe('Custom Opus');
      // Built-in aliases preserved (override supplied none of its own)
      expect(canonical.aliases).toContain('opus');
      // Replacement, not append — total count unchanged
      expect(claude.models.length).toBe(before);
      applyConfigOverrides({ providers: {} });
    });

    it('should canonicalize an alias-keyed override id in the stored override', () => {
      // Regression: the metadata path (mergeModels) resolves aliases, but the
      // runtime path forwards the RAW stored `models` array to the provider, where
      // per-model config is matched by EXACT id against the frontend-submitted
      // canonical id. An alias-keyed entry must therefore be canonicalized before
      // storage, or its cli_model/env/extra_args would be silently dropped.
      applyConfigOverrides({
        providers: {
          claude: {
            models: [
              { id: 'opus', tier: 'thorough', cli_model: 'custom-x' }
            ]
          }
        }
      });
      const overrides = getProviderConfigOverrides('claude');
      const stored = overrides.models.find(m => m.cli_model === 'custom-x');
      expect(stored).toBeDefined();
      // The raw stored id is the canonical built-in id, not the alias 'opus'.
      expect(stored.id).toBe('opus-4.8-xhigh');
      expect(overrides.models.some(m => m.id === 'opus')).toBe(false);
      applyConfigOverrides({ providers: {} });
    });

    it('should leave a canonical-id override id unchanged in the stored override', () => {
      applyConfigOverrides({
        providers: {
          claude: {
            models: [
              { id: 'opus-4.8-xhigh', tier: 'thorough', cli_model: 'custom-y' }
            ]
          }
        }
      });
      const overrides = getProviderConfigOverrides('claude');
      const stored = overrides.models.find(m => m.cli_model === 'custom-y');
      expect(stored).toBeDefined();
      expect(stored.id).toBe('opus-4.8-xhigh');
      applyConfigOverrides({ providers: {} });
    });

    it('should leave an override id with no built-in match unchanged (genuinely new model)', () => {
      applyConfigOverrides({
        providers: {
          claude: {
            models: [
              { id: 'brand-new-model', tier: 'balanced', cli_model: 'cli-new' }
            ]
          }
        }
      });
      const overrides = getProviderConfigOverrides('claude');
      const stored = overrides.models.find(m => m.cli_model === 'cli-new');
      expect(stored).toBeDefined();
      // No built-in matches by id or alias, so the new id is preserved verbatim.
      expect(stored.id).toBe('brand-new-model');
      applyConfigOverrides({ providers: {} });
    });

    it('should include defaultTimeout for providers that define it', () => {
      const providers = getAllProvidersInfo();
      const pi = providers.find(p => p.id === 'pi');
      expect(pi.defaultTimeout).toBe(900000); // 15 minutes
    });

    it('should not include defaultTimeout for providers that do not define it', () => {
      const providers = getAllProvidersInfo();
      const claude = providers.find(p => p.id === 'claude');
      expect(claude.defaultTimeout).toBeUndefined();
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

  describe('aliased providers (type = existing provider)', () => {
    beforeEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    it('should register an aliased provider that reuses the base class', () => {
      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin',
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      expect(getRegisteredProviderIds()).toContain('pi-reskin');
      const AliasClass = getProviderClass('pi-reskin');
      const BaseClass = getProviderClass('pi');
      expect(AliasClass.prototype).toBeInstanceOf(BaseClass);
    });

    it('should override static metadata on the aliased class', () => {
      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin',
            models: [
              { id: 'custom-model', tier: 'thorough', default: true }
            ]
          }
        }
      });

      const AliasClass = getProviderClass('pi-reskin');
      expect(AliasClass.getProviderName()).toBe('Pi Reskin');
      expect(AliasClass.getProviderId()).toBe('pi-reskin');
      expect(AliasClass.getModels()).toHaveLength(1);
      expect(AliasClass.getModels()[0].id).toBe('custom-model');
      expect(AliasClass.getDefaultModel()).toBe('custom-model');
    });

    it('should preserve base class models when alias defines none', () => {
      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin'
          }
        }
      });

      const AliasClass = getProviderClass('pi-reskin');
      const BaseClass = getProviderClass('pi');
      // Without model overrides, should inherit from base
      expect(AliasClass.getModels()).toEqual(BaseClass.getModels());
    });

    it('wires disabled_models and default_model onto the aliased provider overrides', () => {
      applyConfigOverrides({
        providers: {
          myalias: {
            type: 'claude',
            disabled_models: ['haiku'],
            default_model: 'sonnet-4.6'
          }
        }
      });
      expect(getProviderConfigOverrides('myalias').disabled_models).toEqual(['haiku']);
      expect(getProviderConfigOverrides('myalias').default_model).toBe('sonnet-4.6');
    });

    it('should store config overrides for the aliased provider', () => {
      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin',
            command: '/custom/pi',
            extra_args: ['--custom-flag'],
            env: { CUSTOM_VAR: 'value' }
          }
        }
      });

      const overrides = getProviderConfigOverrides('pi-reskin');
      expect(overrides.command).toBe('/custom/pi');
      expect(overrides.extra_args).toEqual(['--custom-flag']);
      expect(overrides.env).toEqual({ CUSTOM_VAR: 'value' });
    });

    it('should create a functional provider instance from alias', () => {
      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin',
            command: '/custom/pi',
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      const provider = createProvider('pi-reskin');
      expect(provider).toBeDefined();
      // Pi provider stores command as piCmd, not command
      expect(provider.piCmd).toBe('/custom/pi');
    });

    it('should appear in getAllProvidersInfo', () => {
      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin',
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      const providers = getAllProvidersInfo();
      const alias = providers.find(p => p.id === 'pi-reskin');
      expect(alias).toBeDefined();
      expect(alias.name).toBe('Pi Reskin');
    });

    it('should not affect the base provider', () => {
      const baseBefore = getProviderClass('pi');
      const baseNameBefore = baseBefore.getProviderName();

      applyConfigOverrides({
        providers: {
          'pi-reskin': {
            type: 'pi',
            name: 'Pi Reskin',
            command: '/different/command'
          }
        }
      });

      const baseAfter = getProviderClass('pi');
      expect(baseAfter.getProviderName()).toBe(baseNameBefore);
      // Base provider should not have the alias overrides
      expect(getProviderConfigOverrides('pi')).toBeUndefined();
    });

    it('should warn and skip for unknown type', () => {
      applyConfigOverrides({
        providers: {
          'unknown-alias': {
            type: 'nonexistent-provider',
            name: 'Should Not Register'
          }
        }
      });

      expect(getRegisteredProviderIds()).not.toContain('unknown-alias');
    });

    it('should work with any built-in provider as base', () => {
      applyConfigOverrides({
        providers: {
          'claude-custom': {
            type: 'claude',
            name: 'Custom Claude',
            extra_args: ['--special']
          }
        }
      });

      expect(getRegisteredProviderIds()).toContain('claude-custom');
      const AliasClass = getProviderClass('claude-custom');
      expect(AliasClass.getProviderName()).toBe('Custom Claude');
      expect(AliasClass.getProviderId()).toBe('claude-custom');
    });

    it('should treat self-referential type as standard override, not alias', () => {
      const originalClass = getProviderClass('pi');

      applyConfigOverrides({
        providers: {
          pi: {
            type: 'pi',
            name: 'Custom Pi',
            command: '/custom/pi'
          }
        }
      });

      // Class should not be replaced — still the original PiProvider
      expect(getProviderClass('pi')).toBe(originalClass);
      // Config overrides should be applied via the standard path
      const overrides = getProviderConfigOverrides('pi');
      expect(overrides).toBeDefined();
      expect(overrides.command).toBe('/custom/pi');
    });

    it('should forward defaultTimeout to the aliased class', () => {
      applyConfigOverrides({
        providers: {
          'pi-custom': {
            type: 'pi',
            name: 'Pi Custom',
            defaultTimeout: 1200000,
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      const AliasClass = getProviderClass('pi-custom');
      expect(AliasClass.defaultTimeout).toBe(1200000);
    });

    it('should inherit base class defaultTimeout when alias does not define one', () => {
      applyConfigOverrides({
        providers: {
          'pi-inherit': {
            type: 'pi',
            name: 'Pi Inherit',
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      const AliasClass = getProviderClass('pi-inherit');
      const BaseClass = getProviderClass('pi');
      // Pi's base class has defaultTimeout = 900000
      // Without an explicit override, the alias inherits from the base prototype chain
      expect(BaseClass.defaultTimeout).toBe(900000);
      // The alias should NOT have its own defaultTimeout property set
      expect(Object.hasOwn(AliasClass, 'defaultTimeout')).toBe(false);
    });

    it('should surface aliased defaultTimeout in getAllProvidersInfo', () => {
      applyConfigOverrides({
        providers: {
          'pi-slow': {
            type: 'pi',
            name: 'Pi Slow',
            defaultTimeout: 1800000,
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      const providers = getAllProvidersInfo();
      const alias = providers.find(p => p.id === 'pi-slow');
      expect(alias).toBeDefined();
      expect(alias.defaultTimeout).toBe(1800000);
    });

    it('should surface aliased defaultTimeout: 0 in getAllProvidersInfo', () => {
      applyConfigOverrides({
        providers: {
          'pi-zero-timeout': {
            type: 'pi',
            name: 'Pi Zero Timeout',
            defaultTimeout: 0,
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });

      const providers = getAllProvidersInfo();
      const alias = providers.find(p => p.id === 'pi-zero-timeout');
      expect(alias).toBeDefined();
      expect(alias.defaultTimeout).toBe(0);
    });

    it('should not set defaultTimeout on alias when not provided', () => {
      applyConfigOverrides({
        providers: {
          'claude-alias': {
            type: 'claude',
            name: 'Claude Alias'
          }
        }
      });

      const AliasClass = getProviderClass('claude-alias');
      // Claude has no defaultTimeout, alias should not either
      expect(Object.hasOwn(AliasClass, 'defaultTimeout')).toBe(false);
    });
  });

  describe('createProvider per-call overrides', () => {
    beforeEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    it('passes per-call load_skills: false to PiProvider', () => {
      const provider = createProvider('pi', 'default', { load_skills: false });
      // PiProvider adds --no-skills when load_skills is false
      expect(provider.baseArgs).toContain('--no-skills');
    });

    it('does not add --no-skills when load_skills is true', () => {
      const provider = createProvider('pi', 'default', { load_skills: true });
      expect(provider.baseArgs).not.toContain('--no-skills');
    });

    it('per-call override supersedes global config override', () => {
      // Global config says load_skills: true
      applyConfigOverrides({
        providers: {
          pi: {
            load_skills: true
          }
        }
      });
      // Per-call override says load_skills: false
      const provider = createProvider('pi', 'default', { load_skills: false });
      expect(provider.baseArgs).toContain('--no-skills');
    });

    it('global config override applies when no per-call override', () => {
      applyConfigOverrides({
        providers: {
          pi: {
            load_skills: false
          }
        }
      });
      const provider = createProvider('pi', 'default');
      expect(provider.baseArgs).toContain('--no-skills');
    });
  });

  describe('createAliasedProviderClass defaultTimeout forwarding', () => {
    it('should set defaultTimeout as static property on alias class', () => {
      const BaseClass = getProviderClass('claude');
      const AliasClass = createAliasedProviderClass('test-alias', BaseClass, {
        name: 'Test Alias',
        defaultTimeout: 1500000
      });

      expect(AliasClass.defaultTimeout).toBe(1500000);
    });

    it('should not set defaultTimeout when not provided in config', () => {
      const BaseClass = getProviderClass('claude');
      const AliasClass = createAliasedProviderClass('test-alias-no-timeout', BaseClass, {
        name: 'Test Alias No Timeout'
      });

      // Should not have its own defaultTimeout property
      expect(Object.hasOwn(AliasClass, 'defaultTimeout')).toBe(false);
    });

    it('should not set defaultTimeout when value is null', () => {
      const BaseClass = getProviderClass('claude');
      const AliasClass = createAliasedProviderClass('test-alias-null', BaseClass, {
        name: 'Test Alias Null',
        defaultTimeout: null
      });

      expect(Object.hasOwn(AliasClass, 'defaultTimeout')).toBe(false);
    });

    it('should set defaultTimeout when value is 0', () => {
      const BaseClass = getProviderClass('claude');
      const AliasClass = createAliasedProviderClass('test-alias-zero', BaseClass, {
        name: 'Test Alias Zero',
        defaultTimeout: 0
      });

      // 0 is not null/undefined, so it should be set
      // The check is `aliasConfig.defaultTimeout != null` — 0 passes this
      expect(AliasClass.defaultTimeout).toBe(0);
    });

    it('should inherit base defaultTimeout through prototype chain', () => {
      const BaseClass = getProviderClass('pi');
      const AliasClass = createAliasedProviderClass('pi-proto-test', BaseClass, {
        name: 'Pi Proto Test'
      });

      // Pi has defaultTimeout = 900000 on the class
      // Alias does not override it, so accessing it traverses the prototype
      expect(BaseClass.defaultTimeout).toBe(900000);
      // The alias should not have its own
      expect(Object.hasOwn(AliasClass, 'defaultTimeout')).toBe(false);
    });
  });

  describe('availability_timeout_seconds', () => {
    beforeEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    afterEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    it('stores availability_timeout_seconds in overrides for standard providers', () => {
      applyConfigOverrides({
        providers: { pi: { availability_timeout_seconds: 30 } }
      });
      expect(getProviderConfigOverrides('pi').availability_timeout_seconds).toBe(30);
    });

    it('stores availability_timeout_seconds in overrides for alias providers', () => {
      applyConfigOverrides({
        providers: {
          'pi-custom': {
            type: 'pi',
            name: 'Custom Pi',
            availability_timeout_seconds: 45,
            models: [{ id: 'default', tier: 'balanced', default: true }]
          }
        }
      });
      expect(getProviderConfigOverrides('pi-custom').availability_timeout_seconds).toBe(45);
    });

    it('stores availability_timeout_seconds in overrides for executable providers', () => {
      applyConfigOverrides({
        providers: {
          'my-tool': {
            type: 'executable',
            command: 'my-tool',
            availability_timeout_seconds: 60
          }
        }
      });
      expect(getProviderConfigOverrides('my-tool').availability_timeout_seconds).toBe(60);
    });

    describe('secondsToTimeoutMs', () => {
      it('converts a positive number of seconds to ms', () => {
        expect(secondsToTimeoutMs(30)).toBe(30000);
        expect(secondsToTimeoutMs(0.5)).toBe(500);
      });

      it('falls back to the default for non-positive or non-numeric values', () => {
        for (const bad of [0, -5, NaN, Infinity, 'abc', null, undefined, {}]) {
          expect(secondsToTimeoutMs(bad)).toBe(DEFAULT_AVAILABILITY_TIMEOUT_MS);
        }
      });

      it('honors a custom defaultMs when the value is invalid', () => {
        expect(secondsToTimeoutMs(0, 5000)).toBe(5000);
        expect(secondsToTimeoutMs('nope', 5000)).toBe(5000);
      });

      it('uses the configured value even when a custom defaultMs is supplied', () => {
        expect(secondsToTimeoutMs(12, 5000)).toBe(12000);
      });
    });

    describe('resolveAvailabilityTimeoutMs', () => {
      it('converts a configured positive value from seconds to ms', () => {
        applyConfigOverrides({
          providers: { pi: { availability_timeout_seconds: 30 } }
        });
        expect(resolveAvailabilityTimeoutMs('pi')).toBe(30000);
      });

      it('falls back to the default when unset', () => {
        applyConfigOverrides({ providers: { pi: { command: '/custom/pi' } } });
        expect(resolveAvailabilityTimeoutMs('pi')).toBe(DEFAULT_AVAILABILITY_TIMEOUT_MS);
      });

      it('falls back to the default for an unknown provider id', () => {
        expect(resolveAvailabilityTimeoutMs('does-not-exist')).toBe(DEFAULT_AVAILABILITY_TIMEOUT_MS);
      });

      it('falls back to the default for non-positive or non-numeric values', () => {
        for (const bad of [0, -5, NaN, 'abc', null]) {
          applyConfigOverrides({
            providers: { pi: { availability_timeout_seconds: bad } }
          });
          expect(resolveAvailabilityTimeoutMs('pi')).toBe(DEFAULT_AVAILABILITY_TIMEOUT_MS);
        }
      });

      it('exposes 10000 as the default timeout constant', () => {
        expect(DEFAULT_AVAILABILITY_TIMEOUT_MS).toBe(10000);
      });
    });
  });

  describe('normalizeDisabledModels', () => {
    // Spy on logger.warn so the warning-behavior tests can assert it fires.
    // Scoped to this describe block and restored after each test so call
    // counts don't leak across tests or into other describe blocks.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns null for null/undefined', () => {
      expect(normalizeDisabledModels('claude', null)).toBe(null);
      expect(normalizeDisabledModels('claude', undefined)).toBe(null);
    });

    it('returns null and warns for a non-array value', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      expect(normalizeDisabledModels('claude', 'haiku')).toBe(null);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returns the list of string ids', () => {
      expect(normalizeDisabledModels('claude', ['haiku', 'fable'])).toEqual(['haiku', 'fable']);
    });

    it('filters out non-string entries', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      expect(normalizeDisabledModels('claude', ['haiku', 42, null, ''])).toEqual(['haiku']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null for an empty (or all-invalid) array', () => {
      expect(normalizeDisabledModels('claude', [])).toBe(null);
      expect(normalizeDisabledModels('claude', [123, null])).toBe(null);
    });
  });

  describe('applyModelOverrides (disabled_models filtering)', () => {
    const builtIns = [
      { id: 'a', tier: 'fast' },
      { id: 'b', tier: 'balanced' },
      { id: 'c', tier: 'thorough' }
    ];

    it('returns merged models unchanged when no disabled_models', () => {
      expect(applyModelOverrides(builtIns, {}).map(m => m.id)).toEqual(['a', 'b', 'c']);
      expect(applyModelOverrides(builtIns, undefined).map(m => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('removes disabled model ids from the effective list', () => {
      const result = applyModelOverrides(builtIns, { disabled_models: ['b'] });
      expect(result.map(m => m.id)).toEqual(['a', 'c']);
    });

    it('removes disabled config-added models too', () => {
      const result = applyModelOverrides(builtIns, {
        models: [{ id: 'd', tier: 'fast' }],
        disabled_models: ['a', 'd']
      });
      expect(result.map(m => m.id)).toEqual(['b', 'c']);
    });

    it('ignores the filter when it would remove every model', () => {
      const result = applyModelOverrides(builtIns, { disabled_models: ['a', 'b', 'c'] });
      expect(result.map(m => m.id)).toEqual(['a', 'b', 'c']);
    });

    it('ignores unknown disabled ids without affecting real ones', () => {
      const result = applyModelOverrides(builtIns, { disabled_models: ['b', 'does-not-exist'] });
      expect(result.map(m => m.id)).toEqual(['a', 'c']);
    });
  });

  describe('disabled_models via config (end to end)', () => {
    beforeEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    afterEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    it('hides a disabled built-in model from getAllProvidersInfo', () => {
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['haiku'] } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.models.find(m => m.id === 'haiku')).toBeUndefined();
      // Other built-ins are still present
      expect(claude.models.find(m => m.id === 'opus-4.8-xhigh')).toBeDefined();
    });

    it('hides the canonical model when disabled_models names an alias (fable)', () => {
      // 'fable' is an alias of the canonical 'fable-5-xhigh'
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['fable'] } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.models.find(m => m.id === 'fable-5-xhigh')).toBeUndefined();
      // Unrelated built-ins remain
      expect(claude.models.find(m => m.id === 'fable-5-high')).toBeDefined();
      expect(claude.models.find(m => m.id === 'opus-4.8-xhigh')).toBeDefined();
    });

    it('hides the canonical model when disabled_models names an alias (opus)', () => {
      // 'opus' is an alias of the canonical 'opus-4.8-xhigh'
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['opus'] } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.models.find(m => m.id === 'opus-4.8-xhigh')).toBeUndefined();
      // Unrelated built-ins remain
      expect(claude.models.find(m => m.id === 'sonnet-4.6')).toBeDefined();
    });

    it('does not warn when disabled_models names a valid alias', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['fable'] } }
      });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('disabled_models references unknown model')
      );
      warnSpy.mockRestore();
    });

    it('stores the normalized disabled_models on the overrides', () => {
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['haiku', 'fable'] } }
      });
      expect(getProviderConfigOverrides('claude').disabled_models).toEqual(['haiku', 'fable']);
    });

    it('moves the default off a disabled model', () => {
      // claude's built-in default is 'opus-4.8-xhigh'; disable it and the resolver picks another
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['opus-4.8-xhigh'] } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.models.find(m => m.id === 'opus-4.8-xhigh')).toBeUndefined();
      expect(claude.defaultModel).not.toBe('opus-4.8-xhigh');
      // The resolved default must be one of the still-available models
      expect(claude.models.find(m => m.id === claude.defaultModel)).toBeDefined();
    });

    it('does not pick a disabled model as the default in createProvider', () => {
      applyConfigOverrides({
        providers: { claude: { disabled_models: ['opus-4.8-xhigh'] } }
      });
      const provider = createProvider('claude');
      expect(provider.model).not.toBe('opus-4.8-xhigh');
    });

    it('wires disabled_models and default_model onto executable provider overrides', () => {
      applyConfigOverrides({
        providers: {
          'exec-tool': {
            type: 'executable',
            command: 'exec-tool',
            disabled_models: ['fast-model'],
            default_model: 'thorough-model',
            models: [
              { id: 'fast-model', tier: 'fast' },
              { id: 'thorough-model', tier: 'thorough' }
            ]
          }
        }
      });
      const overrides = getProviderConfigOverrides('exec-tool');
      expect(overrides.disabled_models).toEqual(['fast-model']);
      expect(overrides.default_model).toBe('thorough-model');
    });
  });

  describe('provider-level default_model', () => {
    beforeEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    afterEach(() => {
      applyConfigOverrides({ providers: {} });
    });

    it('selects the configured default_model in getAllProvidersInfo', () => {
      applyConfigOverrides({
        providers: { claude: { default_model: 'haiku' } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.defaultModel).toBe('haiku');
    });

    it('selects the configured default_model in createProvider', () => {
      applyConfigOverrides({
        providers: { claude: { default_model: 'sonnet-4.6' } }
      });
      const provider = createProvider('claude');
      expect(provider.model).toBe('sonnet-4.6');
    });

    it('resolves a default_model alias to the canonical id in getAllProvidersInfo', () => {
      // 'opus' is an alias of the canonical 'opus-4.8-xhigh'
      applyConfigOverrides({
        providers: { claude: { default_model: 'opus' } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.defaultModel).toBe('opus-4.8-xhigh');
    });

    it('does not warn when default_model names a valid alias', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      applyConfigOverrides({
        providers: { claude: { default_model: 'opus' } }
      });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('is not a known model')
      );
      warnSpy.mockRestore();
    });

    it('falls back to automatic default when default_model names an unknown model', () => {
      applyConfigOverrides({
        providers: { claude: { default_model: 'no-such-model' } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      // Falls back to the built-in default ('opus-4.8-xhigh')
      expect(claude.defaultModel).toBe('opus-4.8-xhigh');
    });

    it('falls back to automatic default when default_model is also disabled', () => {
      applyConfigOverrides({
        providers: { claude: { default_model: 'haiku', disabled_models: ['haiku'] } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.models.find(m => m.id === 'haiku')).toBeUndefined();
      expect(claude.defaultModel).not.toBe('haiku');
    });

    it('default_model wins over a config model marked default:true', () => {
      applyConfigOverrides({
        providers: {
          claude: {
            default_model: 'haiku',
            models: [{ id: 'sonnet-4.6', tier: 'balanced', default: true }]
          }
        }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.defaultModel).toBe('haiku');
    });

    it('stores default_model on the overrides', () => {
      applyConfigOverrides({
        providers: { claude: { default_model: 'haiku' } }
      });
      expect(getProviderConfigOverrides('claude').default_model).toBe('haiku');
    });

    it('normalizes per-model default flags so models.find(m => m.default) agrees with default_model', () => {
      // 'sonnet-4.6' does not carry a legacy default:true flag; the built-in
      // default ('opus-4.8-xhigh') does. After resolving default_model, exactly one model
      // — the targeted one — should be flagged default:true.
      applyConfigOverrides({
        providers: { claude: { default_model: 'sonnet-4.6' } }
      });
      const claude = getAllProvidersInfo().find(p => p.id === 'claude');
      expect(claude.defaultModel).toBe('sonnet-4.6');
      expect(claude.models.find(m => m.default).id).toBe('sonnet-4.6');
      expect(claude.models.filter(m => m.default === true)).toHaveLength(1);
    });
  });
});
