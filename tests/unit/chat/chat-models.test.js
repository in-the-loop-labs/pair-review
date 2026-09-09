// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Real modules throughout — this suite exists to pin the contract between the chat
// model catalog and the review providers it borrows from.
const {
  getProviderClass,
  applyConfigOverrides: applyProviderConfigOverrides,
} = require('../../../src/ai');
const {
  applyConfigOverrides: applyChatConfigOverrides,
  clearConfigOverrides: clearChatConfigOverrides,
  getChatProvider,
} = require('../../../src/chat/chat-providers');
const {
  getChatModelCatalog,
  resolveChatModel,
  canonicalChatModel,
  resolveChatCatalogProviderId,
  _resetForTests: resetChatModelWarnings,
} = require('../../../src/chat/chat-models');
const logger = require('../../../src/utils/logger');

/** Exactly the fields the picker is allowed to see. */
const CATALOG_FIELDS = ['id', 'name', 'tier', 'tagline', 'badge', 'badgeClass', 'description'];
/** Fields that must never cross into the catalog payload. */
const CLI_FIELDS = ['cli_model', 'cliName', 'extra_args', 'env', 'aliases', 'supports_chat'];

/**
 * Built-in models for a review provider, so expectations track the real catalog
 * instead of hard-coding model ids that the update-provider-models skill rotates.
 */
function builtIns(reviewProviderId) {
  return getProviderClass(reviewProviderId).getModels();
}

function firstWith(reviewProviderId, predicate) {
  const model = builtIns(reviewProviderId).find(predicate);
  if (!model) throw new Error(`No ${reviewProviderId} model matched the fixture predicate`);
  return model;
}

describe('chat-models', () => {
  beforeEach(() => {
    clearChatConfigOverrides();
    applyProviderConfigOverrides({});
    resetChatModelWarnings();
  });

  afterEach(() => {
    clearChatConfigOverrides();
    applyProviderConfigOverrides({});
    resetChatModelWarnings();
    vi.restoreAllMocks();
  });

  // ── resolveChatCatalogProviderId ──────────────────────────────

  describe('resolveChatCatalogProviderId', () => {
    it('prefers an explicit models_from', () => {
      expect(resolveChatCatalogProviderId(getChatProvider('cursor-acp'))).toBe('cursor-agent');
      expect(resolveChatCatalogProviderId(getChatProvider('copilot-acp'))).toBe('copilot');
      expect(resolveChatCatalogProviderId(getChatProvider('opencode-acp'))).toBe('opencode');
    });

    it('falls back to type when it names a registered review provider', () => {
      expect(resolveChatCatalogProviderId({ id: 'my-claude', type: 'claude' })).toBe('claude');
    });

    it('returns null when models_from names no registered review provider', () => {
      expect(resolveChatCatalogProviderId({ id: 'x', type: 'claude', models_from: 'nope' })).toBeNull();
    });

    it('returns null for a type with no review provider, and for a missing def', () => {
      expect(resolveChatCatalogProviderId({ id: 'x', type: 'acp' })).toBeNull();
      expect(resolveChatCatalogProviderId(null)).toBeNull();
    });

    it('warns exactly once per provider id for an unregistered models_from', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      applyChatConfigOverrides({ typo: { type: 'acp', command: 'x', models_from: 'claud' } });

      // Two catalog builds — the endpoint rebuilds every provider on every request.
      getChatModelCatalog('typo');
      getChatModelCatalog('typo');

      const mine = warn.mock.calls.filter(([msg]) => String(msg).includes('models_from="claud"'));
      expect(mine).toHaveLength(1);
      expect(mine[0][0]).toContain('"typo"');
    });

    it('warns separately for a second misconfigured provider', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      applyChatConfigOverrides({
        typo: { type: 'acp', command: 'x', models_from: 'claud' },
        'typo-two': { type: 'acp', command: 'x', models_from: 'codx' },
      });

      getChatModelCatalog('typo');
      getChatModelCatalog('typo-two');
      getChatModelCatalog('typo');
      getChatModelCatalog('typo-two');

      expect(warn.mock.calls.filter(([m]) => String(m).includes('models_from='))).toHaveLength(2);
    });

    it('does not warn for a provider whose catalog resolves', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      getChatModelCatalog('claude');
      getChatModelCatalog('cursor-acp');
      getChatModelCatalog('claude');
      expect(warn.mock.calls.filter(([m]) => String(m).includes('models_from='))).toHaveLength(0);
    });
  });

  // ── getChatModelCatalog ───────────────────────────────────────

  describe('getChatModelCatalog', () => {
    it('exposes only display fields and strips every CLI-facing field', () => {
      const { models } = getChatModelCatalog('claude');
      expect(models.length).toBe(builtIns('claude').length);

      for (const entry of models) {
        expect(Object.keys(entry).sort()).toEqual([...CATALOG_FIELDS].sort());
        for (const banned of CLI_FIELDS) {
          expect(entry).not.toHaveProperty(banned);
        }
      }

      // The source models genuinely carry the stripped fields, so this is a real strip.
      expect(builtIns('claude').some(m => m.cli_model !== undefined)).toBe(true);
      expect(builtIns('claude').some(m => m.env !== undefined)).toBe(true);
    });

    it('uses models_from rather than the chat provider type', () => {
      // cursor-acp has type 'acp' (no such review provider) and models_from 'cursor-agent'.
      const { models } = getChatModelCatalog('cursor-acp');
      expect(models.length).toBe(builtIns('cursor-agent').length);
      expect(models.map(m => m.id)).toEqual(builtIns('cursor-agent').map(m => m.id));
    });

    it('falls back to type for a config-defined provider with no models_from', () => {
      applyChatConfigOverrides({ 'my-claude': { type: 'claude', command: 'claude' } });
      const { models } = getChatModelCatalog('my-claude');
      expect(models.map(m => m.id)).toEqual(builtIns('claude').map(m => m.id));
    });

    it('honors a config models_from that repoints the catalog', () => {
      applyChatConfigOverrides({ 'my-agent': { type: 'acp', command: 'x', models_from: 'codex' } });
      const { models } = getChatModelCatalog('my-agent');
      expect(models.map(m => m.id)).toEqual(builtIns('codex').map(m => m.id));
    });

    it('returns an empty catalog for a provider with no catalog', () => {
      applyChatConfigOverrides({ mystery: { type: 'acp', command: 'mystery' } });
      expect(getChatModelCatalog('mystery')).toEqual({ models: [], configuredModel: null, hasCatalog: false });
    });

    it('reports hasCatalog from the model count, not from the mapping', () => {
      expect(getChatModelCatalog('claude').hasCatalog).toBe(true);

      // opencode-acp maps to a *registered* review provider that ships no models.
      // The mapping resolves, so the old mapping-based flag said "true" while the
      // picker had nothing but the default row.
      expect(resolveChatCatalogProviderId(getChatProvider('opencode-acp'))).toBe('opencode');
      const empty = getChatModelCatalog('opencode-acp');
      expect(empty.models).toEqual([]);
      expect(empty.hasCatalog).toBe(false);
    });

    it('returns an empty catalog for an unknown provider id', () => {
      expect(getChatModelCatalog('does-not-exist')).toEqual({ models: [], configuredModel: null, hasCatalog: false });
    });

    it('reflects config model overrides and disabled_models', () => {
      const disabled = builtIns('claude')[0].id;
      applyProviderConfigOverrides({
        providers: {
          claude: {
            disabled_models: [disabled],
            models: [{ id: 'house-blend', tier: 'balanced', cli_model: 'claude-house', name: 'House Blend' }],
          },
        },
      });
      const { models } = getChatModelCatalog('claude');
      expect(models.map(m => m.id)).not.toContain(disabled);
      expect(models.map(m => m.id)).toContain('house-blend');
    });

    it('fills in display defaults so the picker never shows a bare id', () => {
      applyProviderConfigOverrides({
        providers: {
          claude: { models: [{ id: 'bare-model-id', tier: 'fast', cli_model: 'x' }] },
        },
      });
      const entry = getChatModelCatalog('claude').models.find(m => m.id === 'bare-model-id');
      expect(entry.name).toBe('Bare Model Id');
      expect(entry.badge).toBeTruthy();
      expect(entry.badgeClass).toBeTruthy();
      expect(entry.tagline).toBe('');
      expect(entry.description).toBe('');
    });

    it('normalizes a tier alias to its canonical tier', () => {
      applyProviderConfigOverrides({
        providers: { claude: { models: [{ id: 'premium-model', tier: 'premium', cli_model: 'x' }] } },
      });
      const entry = getChatModelCatalog('claude').models.find(m => m.id === 'premium-model');
      expect(entry.tier).toBe('thorough');
      expect(Object.keys(entry).sort()).toEqual([...CATALOG_FIELDS].sort());
    });

    describe('configuredModel', () => {
      it('is null when chat_providers.<id>.model is unset', () => {
        expect(getChatModelCatalog('claude').configuredModel).toBeNull();
      });

      it('passes a canonical id through unchanged', () => {
        const canonical = builtIns('claude')[0].id;
        applyChatConfigOverrides({ claude: { model: canonical } });
        expect(getChatModelCatalog('claude').configuredModel).toBe(canonical);
      });

      it('resolves an alias to the canonical id', () => {
        const aliased = firstWith('claude', m => Array.isArray(m.aliases) && m.aliases.length > 0);
        applyChatConfigOverrides({ claude: { model: aliased.aliases[0] } });
        expect(getChatModelCatalog('claude').configuredModel).toBe(aliased.id);
      });

      it('returns a raw CLI string verbatim when it is not in the catalog', () => {
        applyChatConfigOverrides({ claude: { model: 'claude-sonnet-4-6' } });
        expect(getChatModelCatalog('claude').configuredModel).toBe('claude-sonnet-4-6');
      });

      it('returns the raw string for a provider with no catalog', () => {
        applyChatConfigOverrides({ mystery: { type: 'acp', command: 'm', model: 'whatever' } });
        expect(getChatModelCatalog('mystery')).toEqual({ models: [], hasCatalog: false, configuredModel: 'whatever' });
      });
    });
  });

  // ── resolveChatModel ──────────────────────────────────────────

  describe('resolveChatModel', () => {
    it('returns the provider-default shape for a null or undefined selector', () => {
      const expected = { id: null, cliModel: null, extraArgs: [], env: {}, known: false };
      expect(resolveChatModel('claude', null)).toEqual(expected);
      expect(resolveChatModel('claude', undefined)).toEqual(expected);
      expect(resolveChatModel('claude')).toEqual(expected);
    });

    it('resolves a canonical id to its cli_model', () => {
      const model = firstWith('claude', m => typeof m.cli_model === 'string');
      const resolved = resolveChatModel('claude', model.id);
      expect(resolved.id).toBe(model.id);
      expect(resolved.cliModel).toBe(model.cli_model);
      expect(resolved.known).toBe(true);
    });

    it('resolves an alias to the canonical id', () => {
      const aliased = firstWith('claude', m => Array.isArray(m.aliases) && m.aliases.length > 0);
      const resolved = resolveChatModel('claude', aliased.aliases[0]);
      expect(resolved.id).toBe(aliased.id);
      expect(resolved.cliModel).toBe(aliased.cli_model ?? aliased.id);
      expect(resolved.known).toBe(true);
    });

    it('carries the effort env for a Claude effort entry', () => {
      const model = firstWith('claude', m => m.env && Object.keys(m.env).length > 0);
      const resolved = resolveChatModel('claude', model.id);
      expect(resolved.env).toEqual(model.env);
      expect(resolved.env).toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL');
      // Copy, not the shared catalog object.
      expect(resolved.env).not.toBe(model.env);
      resolved.env.MUTATED = '1';
      expect(model.env.MUTATED).toBeUndefined();
    });

    it('carries the effort extra_args for a Codex effort entry', () => {
      const model = firstWith('codex', m => Array.isArray(m.extra_args) && m.extra_args.length > 0);
      const resolved = resolveChatModel('codex', model.id);
      expect(resolved.extraArgs).toEqual(model.extra_args);
      expect(resolved.extraArgs).toContain('-c');
      expect(resolved.extraArgs.some(a => a.startsWith('model_reasoning_effort='))).toBe(true);
      // Copy, not the shared catalog array.
      expect(resolved.extraArgs).not.toBe(model.extra_args);
      resolved.extraArgs.push('--mutated');
      expect(model.extra_args).not.toContain('--mutated');
    });

    it('maps cli_model: null to cliModel: null (no model flag)', () => {
      const model = firstWith('pi', m => m.cli_model === null);
      const resolved = resolveChatModel('pi', model.id);
      expect(resolved).toEqual({
        id: model.id,
        cliModel: null,
        extraArgs: model.extra_args ? [...model.extra_args] : [],
        env: model.env ? { ...model.env } : {},
        known: true,
      });
    });

    it('ignores cliName — only cli_model and the id are chat rungs', () => {
      // `cliName` is antigravity-only, and antigravity has no chat provider (no ACP
      // mode), so the chat ladder is cli_model > id. Pinned so the rung is not
      // reintroduced by accident.
      applyProviderConfigOverrides({
        providers: { claude: { models: [{ id: 'named-model', tier: 'balanced', cliName: 'Fancy Name' }] } },
      });
      const resolved = resolveChatModel('claude', 'named-model');
      expect(resolved.cliModel).toBe('named-model');
      expect(resolved.known).toBe(true);
    });

    it('falls back to the canonical id when cli_model is not set', () => {
      applyProviderConfigOverrides({
        providers: { claude: { models: [{ id: 'plain-model', tier: 'balanced' }] } },
      });
      expect(resolveChatModel('claude', 'plain-model').cliModel).toBe('plain-model');
    });

    it('passes an unknown selector through verbatim', () => {
      expect(resolveChatModel('claude', 'claude-sonnet-4-6')).toEqual({
        id: 'claude-sonnet-4-6',
        cliModel: 'claude-sonnet-4-6',
        extraArgs: [],
        env: {},
        known: false,
      });
    });

    it('passes through for a provider with no catalog at all', () => {
      applyChatConfigOverrides({ mystery: { type: 'acp', command: 'm' } });
      expect(resolveChatModel('mystery', 'anything')).toEqual({
        id: 'anything',
        cliModel: 'anything',
        extraArgs: [],
        env: {},
        known: false,
      });
    });

    it('passes through for an unknown chat provider id', () => {
      expect(resolveChatModel('does-not-exist', 'some-model').known).toBe(false);
    });

    it('accepts a pre-resolved provider def instead of looking one up', () => {
      const model = firstWith('codex', m => typeof m.cli_model === 'string');
      // Note the chat provider id is deliberately bogus: the def must win.
      const resolved = resolveChatModel('ignored', model.id, { id: 'ignored', type: 'acp', models_from: 'codex' });
      expect(resolved.id).toBe(model.id);
      expect(resolved.cliModel).toBe(model.cli_model);
    });
  });

  // mergeModels replaces a matched built-in wholesale, so a partial `models` override
  // erases cli_model/extra_args/env on the merged entry. Chat must resolve those fields
  // against the built-in and the override separately, like the review providers do.
  describe('resolveChatModel with a partial config override', () => {
    it('keeps the built-in cli_model and effort env when only display fields are overridden', () => {
      const model = firstWith('claude', m => m.cli_model && m.env && m.env.CLAUDE_CODE_EFFORT_LEVEL);
      applyProviderConfigOverrides({
        providers: {
          claude: { models: [{ id: model.id, tier: 'thorough', name: 'Team Opus' }] },
        },
      });

      const resolved = resolveChatModel('claude', model.id);
      expect(resolved.id).toBe(model.id);
      expect(resolved.cliModel).toBe(model.cli_model);
      expect(resolved.env).toEqual(model.env);
      expect(resolved.known).toBe(true);
    });

    it('keeps the built-in extra_args for a Codex effort entry', () => {
      const model = firstWith('codex', m => Array.isArray(m.extra_args) && m.extra_args.length > 0);
      applyProviderConfigOverrides({
        providers: {
          codex: { models: [{ id: model.id, tier: model.tier, name: 'Team Codex' }] },
        },
      });

      const resolved = resolveChatModel('codex', model.id);
      expect(resolved.extraArgs).toEqual(model.extra_args);
      expect(resolved.cliModel).toBe(model.cli_model ?? model.id);
    });

    it('matches an override keyed by a built-in alias', () => {
      const aliased = firstWith('claude', m => Array.isArray(m.aliases) && m.aliases.length > 0 && m.cli_model);
      applyProviderConfigOverrides({
        providers: {
          claude: { models: [{ id: aliased.aliases[0], tier: aliased.tier, name: 'Aliased' }] },
        },
      });

      const resolved = resolveChatModel('claude', aliased.id);
      expect(resolved.id).toBe(aliased.id);
      expect(resolved.cliModel).toBe(aliased.cli_model);
    });

    it('lets an explicit cli_model: null in config suppress the built-in cli_model', () => {
      const model = firstWith('claude', m => typeof m.cli_model === 'string');
      applyProviderConfigOverrides({
        providers: {
          claude: { models: [{ id: model.id, tier: model.tier, cli_model: null }] },
        },
      });

      const resolved = resolveChatModel('claude', model.id);
      expect(resolved.cliModel).toBeNull();
      expect(resolved.known).toBe(true);
    });

    it('lets a config extra_args/env append to and override the built-in', () => {
      const model = firstWith('claude', m => m.env && m.env.CLAUDE_CODE_EFFORT_LEVEL);
      applyProviderConfigOverrides({
        providers: {
          claude: {
            models: [{
              id: model.id,
              tier: model.tier,
              extra_args: ['--extra'],
              env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', TEAM: '1' },
            }],
          },
        },
      });

      const resolved = resolveChatModel('claude', model.id);
      expect(resolved.extraArgs).toEqual([...(model.extra_args || []), '--extra']);
      expect(resolved.env).toEqual({ ...model.env, CLAUDE_CODE_EFFORT_LEVEL: 'low', TEAM: '1' });
    });
  });

  describe('supports_chat', () => {
    /** Pi ships the analysis-only pseudo-models; they are the fixture for this block. */
    function analysisOnly() {
      return builtIns('pi').filter(m => m.supports_chat === false);
    }

    it('marks Pi\'s review-skill pseudo-models analysis-only', () => {
      const ids = analysisOnly().map(m => m.id);
      expect(ids).toContain('multi-model');
      expect(ids).toContain('review-roulette');
    });

    it('keeps them in the analysis catalog', () => {
      // The review provider's own catalog must be untouched — only chat filters.
      const ids = builtIns('pi').map(m => m.id);
      expect(ids).toContain('multi-model');
      expect(ids).toContain('review-roulette');
    });

    it('hides them from the chat picker', () => {
      const { models } = getChatModelCatalog('pi');
      for (const excluded of analysisOnly()) {
        expect(models.some(m => m.id === excluded.id)).toBe(false);
      }
    });

    it('resolves a selector naming one to the provider default, not a passthrough', () => {
      for (const excluded of analysisOnly()) {
        const resolved = resolveChatModel('pi', excluded.id);
        expect(resolved).toEqual({ id: null, cliModel: null, extraArgs: [], env: {}, known: false });
      }
    });

    it('never leaks the review --skill args or PI_TASK_MAX_DEPTH into a chat session', () => {
      const roulette = builtIns('pi').find(m => m.id === 'review-roulette');
      const resolved = resolveChatModel('pi', roulette.id);
      expect(resolved.extraArgs).toEqual([]);
      expect(resolved.env).toEqual({});
      expect(roulette.extra_args).toContain('--skill');
    });

    it('warns once per provider+selector', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      resolveChatModel('pi', 'multi-model');
      resolveChatModel('pi', 'multi-model');
      const forThis = warn.mock.calls.filter(c => String(c[0]).includes('multi-model'));
      expect(forThis).toHaveLength(1);
      expect(String(forThis[0][0])).toContain('analysis-only');
      warn.mockRestore();
    });

    it('reports configuredModel null when chat_providers.<id>.model names one', () => {
      applyChatConfigOverrides({ pi: { model: 'review-roulette' } });
      expect(getChatModelCatalog('pi').configuredModel).toBeNull();
    });
  });

  describe('provider-default catalog rows', () => {
    it('suppresses a row that resolves to no CLI model, args, or env', () => {
      // Pi's and OMP's `default` entries mean exactly what the picker's own
      // "Provider default" row means, so listing them would duplicate the choice.
      for (const providerId of ['pi', 'omp']) {
        const bare = builtIns(providerId).find(
          m => m.cli_model === null && !m.extra_args && !m.env
        );
        expect(bare, `${providerId} should ship a bare default entry`).toBeTruthy();
        const { models } = getChatModelCatalog(providerId);
        expect(models.some(m => m.id === bare.id)).toBe(false);
      }
    });

    it('still resolves a suppressed row, so a stored session keeps working', () => {
      const bare = builtIns('pi').find(m => m.cli_model === null && !m.extra_args && !m.env);
      const resolved = resolveChatModel('pi', bare.id);
      expect(resolved.id).toBe(bare.id);
      expect(resolved.cliModel).toBeNull();
      expect(resolved.known).toBe(true);
    });

    it('reports configuredModel null for a suppressed row', () => {
      const bare = builtIns('pi').find(m => m.cli_model === null && !m.extra_args && !m.env);
      applyChatConfigOverrides({ pi: { model: bare.id } });
      expect(getChatModelCatalog('pi').configuredModel).toBeNull();
    });

    it('keeps a cli_model: null row that carries env or args', () => {
      applyProviderConfigOverrides({
        providers: {
          claude: {
            models: [{
              id: 'env-only',
              tier: 'thorough',
              cli_model: null,
              env: { ANTHROPIC_MODEL: 'claude-opus-5' },
            }],
          },
        },
      });
      const { models } = getChatModelCatalog('claude');
      expect(models.some(m => m.id === 'env-only')).toBe(true);
    });

    it('leaves Pi with no pickable catalog once both filters apply', () => {
      // Every built-in Pi entry is either analysis-only or a bare provider default.
      const { models, hasCatalog } = getChatModelCatalog('pi');
      expect(models).toEqual([]);
      expect(hasCatalog).toBe(false);
    });
  });

  describe('canonicalChatModel', () => {
    it('returns null for a null or undefined stored model', () => {
      expect(canonicalChatModel('claude', null)).toBeNull();
      expect(canonicalChatModel('claude', undefined)).toBeNull();
    });

    it('canonicalises an alias stored by an older build', () => {
      const aliased = firstWith('claude', m => Array.isArray(m.aliases) && m.aliases.length > 0);
      expect(canonicalChatModel('claude', aliased.aliases[0])).toBe(aliased.id);
    });

    it('passes an unknown raw CLI string through', () => {
      expect(canonicalChatModel('claude', 'some-raw-cli-model')).toBe('some-raw-cli-model');
    });

    it('returns null for a stored analysis-only model', () => {
      expect(canonicalChatModel('pi', 'review-roulette')).toBeNull();
    });
  });
});
