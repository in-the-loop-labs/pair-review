// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for resolveDefaultProviderModel() in src/routes/config.js.
 *
 * The endpoint must return a *coherent* provider/model pair. Because
 * DEFAULT_CONFIG.default_model is always populated (e.g. 'opus'), a provider-only
 * override such as `default_provider: 'antigravity'` previously inherited the Anthropic
 * 'opus' model and produced a mismatched pair. The fix only honours an explicit
 * model when it belongs to the selected provider's own model list.
 */
import { describe, it, expect } from 'vitest';

const { _resolveDefaultProviderModel } = require('../../src/routes/config.js');
const { getAllProvidersInfo } = require('../../src/ai');

const providers = getAllProvidersInfo();
const claude = providers.find(p => p.id === 'claude');
// A claude model that exposes at least one alias, used to exercise the
// alias-named default_model path (e.g. 'opus' → canonical 'opus-4.8-xhigh').
const aliasedModel = claude.models.find(m => Array.isArray(m.aliases) && m.aliases.length > 0);
// Pick any non-claude provider whose model list does NOT contain claude's default
// model id, so we can exercise the "foreign inherited model" path.
const foreign = providers.find(
  p => p.id !== 'claude' && !p.models.some(m => m.id === claude.defaultModel)
);

function modelIds(provider) {
  return provider.models.map(m => m.id);
}

describe('resolveDefaultProviderModel', () => {
  it('honours an explicit model that belongs to the selected provider', () => {
    const validModel = claude.models[0].id;
    const result = _resolveDefaultProviderModel({
      default_provider: 'claude',
      default_model: validModel
    });
    expect(result).toEqual({ provider: 'claude', model: validModel });
  });

  it('falls back to the provider default when the inherited model is foreign', () => {
    expect(foreign, 'expected a non-claude provider for this test').toBeTruthy();
    // Simulate a provider-only override inheriting DEFAULT_CONFIG.default_model.
    const result = _resolveDefaultProviderModel({
      default_provider: foreign.id,
      default_model: claude.defaultModel
    });
    expect(result.provider).toBe(foreign.id);
    expect(result.model).not.toBe(claude.defaultModel);
    expect(result.model).toBe(foreign.defaultModel);
  });

  it('always returns a model that belongs to the returned provider', () => {
    const result = _resolveDefaultProviderModel({
      default_provider: foreign.id,
      default_model: claude.defaultModel
    });
    const provider = providers.find(p => p.id === result.provider);
    expect(modelIds(provider)).toContain(result.model);
  });

  it('derives the provider default when no model is configured', () => {
    const result = _resolveDefaultProviderModel({ default_provider: foreign.id });
    expect(result).toEqual({ provider: foreign.id, model: foreign.defaultModel });
  });

  it('returns the canonical id when default_model names an alias', () => {
    // Regression: an alias-named default_model (e.g. 'opus') passed the membership
    // check but was returned verbatim. The frontend matches model cards by canonical
    // id only, so the raw alias matched no card and was silently replaced by the
    // provider default. The resolver must return the canonical id instead.
    expect(aliasedModel, 'expected a claude model with at least one alias').toBeTruthy();
    const alias = aliasedModel.aliases[0];
    const result = _resolveDefaultProviderModel({
      default_provider: 'claude',
      default_model: alias
    });
    expect(result.provider).toBe('claude');
    expect(result.model).toBe(aliasedModel.id);
    expect(result.model).not.toBe(alias);
  });

  it('honours the legacy `model` field when valid for the provider', () => {
    const validModel = foreign.models[0].id;
    const result = _resolveDefaultProviderModel({
      default_provider: foreign.id,
      model: validModel
    });
    expect(result).toEqual({ provider: foreign.id, model: validModel });
  });
});
