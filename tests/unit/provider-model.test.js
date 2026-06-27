// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for resolveProviderModelPair() — the shared resolver that prevents
 * mismatched provider/model pairs (e.g. gemini + opus) from being produced when
 * different scopes override only one half of the pair.
 */
import { describe, it, expect } from 'vitest';

const { resolveProviderModelPair } = require('../../public/js/utils/provider-model.js');

const PROVIDERS = [
  {
    id: 'claude',
    defaultModel: 'opus',
    // `sonnet-4.6` carries an alias to exercise alias-aware membership matching.
    models: [{ id: 'opus' }, { id: 'sonnet-4.6', aliases: ['sonnet'] }, { id: 'haiku' }]
  },
  {
    id: 'gemini',
    defaultModel: 'gemini-2.5-pro',
    models: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }]
  }
];

describe('resolveProviderModelPair', () => {
  it('keeps a matched pair from the first scope', () => {
    expect(resolveProviderModelPair([{ provider: 'claude', model: 'opus' }], PROVIDERS))
      .toEqual({ provider: 'claude', model: 'opus' });
  });

  it('derives the model from the provider when the scope omits the model', () => {
    expect(resolveProviderModelPair([{ provider: 'gemini', model: null }], PROVIDERS))
      .toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('replaces a foreign model with the provider default instead of mixing halves', () => {
    // gemini provider paired with an Anthropic model — must not be returned as-is.
    expect(resolveProviderModelPair([{ provider: 'gemini', model: 'opus' }], PROVIDERS))
      .toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('does not mix a provider from one scope with a model from another', () => {
    // Repo overrides provider only; app config supplies a (foreign) model.
    const scopes = [
      { provider: 'gemini', model: null },
      { provider: 'claude', model: 'opus' }
    ];
    expect(resolveProviderModelPair(scopes, PROVIDERS))
      .toEqual({ provider: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('attributes a model-only scope to whichever provider owns the model', () => {
    expect(resolveProviderModelPair([{ provider: null, model: 'gemini-2.5-flash' }], PROVIDERS))
      .toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
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
    expect(resolveProviderModelPair([{ provider: 'gemini', model: null }], []))
      .toEqual({ provider: 'gemini', model: null });
    expect(resolveProviderModelPair([], []))
      .toEqual({ provider: 'claude', model: null });
  });

  it('handles non-array inputs defensively', () => {
    expect(resolveProviderModelPair(undefined, undefined))
      .toEqual({ provider: 'claude', model: null });
  });
});
