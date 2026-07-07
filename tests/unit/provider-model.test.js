// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for resolveProviderModelPair() — the shared resolver that prevents
 * mismatched provider/model pairs (e.g. antigravity + opus) from being produced when
 * different scopes override only one half of the pair.
 */
import { describe, it, expect } from 'vitest';

const {
  resolveProviderModelPair,
  buildProviderModelScopes,
  hasProviderModelOverride
} = require('../../public/js/utils/provider-model.js');

const PROVIDERS = [
  {
    id: 'claude',
    defaultModel: 'opus',
    // `sonnet-4.6` carries an alias to exercise alias-aware membership matching.
    models: [{ id: 'opus' }, { id: 'sonnet-4.6', aliases: ['sonnet'] }, { id: 'haiku' }]
  },
  {
    id: 'antigravity',
    defaultModel: 'gemini-3.1-pro-low',
    models: [{ id: 'gemini-3.1-pro-low' }, { id: 'gemini-3.5-flash-low' }]
  }
];

describe('resolveProviderModelPair', () => {
  it('keeps a matched pair from the first scope', () => {
    expect(resolveProviderModelPair([{ provider: 'claude', model: 'opus' }], PROVIDERS))
      .toEqual({ provider: 'claude', model: 'opus' });
  });

  it('derives the model from the provider when the scope omits the model', () => {
    expect(resolveProviderModelPair([{ provider: 'antigravity', model: null }], PROVIDERS))
      .toEqual({ provider: 'antigravity', model: 'gemini-3.1-pro-low' });
  });

  it('replaces a foreign model with the provider default instead of mixing halves', () => {
    // antigravity provider paired with an Anthropic model — must not be returned as-is.
    expect(resolveProviderModelPair([{ provider: 'antigravity', model: 'opus' }], PROVIDERS))
      .toEqual({ provider: 'antigravity', model: 'gemini-3.1-pro-low' });
  });

  it('does not mix a provider from one scope with a model from another', () => {
    // Repo overrides provider only; app config supplies a (foreign) model.
    const scopes = [
      { provider: 'antigravity', model: null },
      { provider: 'claude', model: 'opus' }
    ];
    expect(resolveProviderModelPair(scopes, PROVIDERS))
      .toEqual({ provider: 'antigravity', model: 'gemini-3.1-pro-low' });
  });

  it('attributes a model-only scope to whichever provider owns the model', () => {
    expect(resolveProviderModelPair([{ provider: null, model: 'gemini-3.5-flash-low' }], PROVIDERS))
      .toEqual({ provider: 'antigravity', model: 'gemini-3.5-flash-low' });
  });

  it('keeps a model named by an alias rather than falling back to the default', () => {
    // A persisted value may name an alias ('sonnet') instead of the canonical id
    // ('sonnet-4.6'). It belongs to claude, so the user's choice must be kept.
    expect(resolveProviderModelPair([{ provider: 'claude', model: 'sonnet' }], PROVIDERS))
      .toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('attributes a model-only scope named by an alias to its owning provider', () => {
    expect(resolveProviderModelPair([{ provider: null, model: 'sonnet' }], PROVIDERS))
      .toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('falls back to the provider default for an unknown id (not an alias)', () => {
    expect(resolveProviderModelPair([{ provider: 'claude', model: 'opus-99' }], PROVIDERS))
      .toEqual({ provider: 'claude', model: 'opus' });
  });

  it('falls through a model-only scope whose model no provider owns', () => {
    const scopes = [
      { provider: null, model: 'unknown-model' },
      { provider: 'claude', model: 'sonnet-4.6' }
    ];
    expect(resolveProviderModelPair(scopes, PROVIDERS))
      .toEqual({ provider: 'claude', model: 'sonnet-4.6' });
  });

  it('passes through an unknown provider without inventing a model', () => {
    expect(resolveProviderModelPair([{ provider: 'mystery', model: 'x1' }], PROVIDERS))
      .toEqual({ provider: 'mystery', model: 'x1' });
  });

  it('falls back to claude + its default when no scope resolves', () => {
    expect(resolveProviderModelPair([null, {}], PROVIDERS))
      .toEqual({ provider: 'claude', model: 'opus' });
  });

  it('returns a null model when no provider metadata is available', () => {
    expect(resolveProviderModelPair([{ provider: 'antigravity', model: null }], []))
      .toEqual({ provider: 'antigravity', model: null });
    expect(resolveProviderModelPair([], []))
      .toEqual({ provider: 'claude', model: null });
  });

  it('handles non-array inputs defensively', () => {
    expect(resolveProviderModelPair(undefined, undefined))
      .toEqual({ provider: 'claude', model: null });
  });
});

describe('buildProviderModelScopes', () => {
  it('returns [repo, app] order when no override is present', () => {
    const scopes = buildProviderModelScopes(
      { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' },
      { default_provider: 'claude', default_model: 'opus' }
    );
    expect(scopes).toEqual([
      { provider: 'antigravity', model: 'gemini-3.1-pro-low' },
      { provider: 'claude', model: 'opus' }
    ]);
  });

  it('prepends the env override (appConfig.provider_override) ahead of repo settings', () => {
    const scopes = buildProviderModelScopes(
      { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' },
      { default_provider: 'claude', default_model: 'opus', provider_override: 'codex', model_override: 'gpt-5.5' }
    );
    expect(scopes[0]).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    // The env override must outrank repo settings.
    expect(resolveProviderModelPair(scopes, PROVIDERS).provider).toBe('codex');
  });

  it('prepends a provider-only env override with a null model', () => {
    const scopes = buildProviderModelScopes(
      { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' },
      { provider_override: 'codex' }
    );
    expect(scopes[0]).toEqual({ provider: 'codex', model: null });
  });

  it('ranks the per-invocation (URL) override above the env override', () => {
    const scopes = buildProviderModelScopes(
      { default_provider: 'antigravity', default_model: 'gemini-3.1-pro-low' },
      { provider_override: 'codex', model_override: 'gpt-5.5' },
      { provider: 'pi', model: 'multi-model' }
    );
    expect(scopes[0]).toEqual({ provider: 'pi', model: 'multi-model' });
    expect(scopes[1]).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('ignores an empty extraOverride', () => {
    const scopes = buildProviderModelScopes(
      { default_provider: 'antigravity' },
      {},
      { provider: null, model: null }
    );
    expect(scopes).toEqual([
      { provider: 'antigravity', model: undefined },
      { provider: undefined, model: undefined }
    ]);
  });

  it('handles null appConfig defensively', () => {
    const scopes = buildProviderModelScopes({ default_provider: 'claude' }, null);
    expect(scopes).toEqual([
      { provider: 'claude', model: undefined },
      { provider: undefined, model: undefined }
    ]);
  });
});

describe('hasProviderModelOverride', () => {
  it('is false with no override', () => {
    expect(hasProviderModelOverride({})).toBe(false);
    expect(hasProviderModelOverride(null, null)).toBe(false);
  });

  it('is true when appConfig carries an env override', () => {
    expect(hasProviderModelOverride({ provider_override: 'codex' })).toBe(true);
    expect(hasProviderModelOverride({ model_override: 'gpt-5.5' })).toBe(true);
  });

  it('is true when a per-invocation override is present', () => {
    expect(hasProviderModelOverride({}, { provider: 'codex' })).toBe(true);
    expect(hasProviderModelOverride({}, { model: 'gpt-5.5' })).toBe(true);
  });

  it('is false when the per-invocation override has only null halves', () => {
    expect(hasProviderModelOverride({}, { provider: null, model: null })).toBe(false);
  });
});
