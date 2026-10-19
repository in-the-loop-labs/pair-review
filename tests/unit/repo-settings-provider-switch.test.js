// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for RepoSettingsPage.mapModelForProviderSwitch — the tier mapping
 * applied when the user changes the repo's default provider. The result is
 * saved as the repo's default_model, so a bad pick (e.g. a plan-gated model)
 * breaks every later analysis for the repo, headless runs included.
 */
import { describe, it, expect } from 'vitest';

const { RepoSettingsPage } = require('../../public/js/repo-settings.js');
const ClaudeProvider = require('../../src/ai/claude-provider.js');
const AntigravityProvider = require('../../src/ai/antigravity-provider.js');

const page = Object.create(RepoSettingsPage.prototype);
const claude = { id: 'claude', models: ClaudeProvider.getModels() };
const antigravity = { id: 'antigravity', models: AntigravityProvider.getModels() };

describe('RepoSettingsPage.mapModelForProviderSwitch', () => {
  it('maps a thorough Claude model to the Antigravity default, not plan-gated Argon', () => {
    const thoroughClaude = claude.models.find(m => m.tier === 'thorough');
    expect(page.mapModelForProviderSwitch(claude, antigravity, thoroughClaude.id))
      .toBe('gemini-3.8-flash-high');
  });

  it('resolves the current model by alias before matching its tier', () => {
    const aliased = claude.models.find(m => m.tier === 'fast' && m.aliases?.length);
    expect(aliased).toBeDefined();
    expect(page.mapModelForProviderSwitch(claude, antigravity, aliased.aliases[0]))
      .toBe('gemini-3.8-flash-low');
  });

  it('prefers the default within the tier even when a non-default leads that tier', () => {
    const oldP = { models: [{ id: 'a', tier: 'thorough' }] };
    const newP = { models: [
      { id: 'gated', tier: 'thorough' },
      { id: 'safe', tier: 'thorough', default: true }
    ] };
    expect(page.mapModelForProviderSwitch(oldP, newP, 'a')).toBe('safe');
  });

  it('falls back to the first model of the tier when the default is in another tier', () => {
    const oldP = { models: [{ id: 'a', tier: 'fast' }] };
    const newP = { models: [
      { id: 'd', tier: 'thorough', default: true },
      { id: 'f1', tier: 'fast' },
      { id: 'f2', tier: 'fast' }
    ] };
    expect(page.mapModelForProviderSwitch(oldP, newP, 'a')).toBe('f1');
  });

  it('uses the new provider default when the current model is unknown', () => {
    expect(page.mapModelForProviderSwitch(claude, antigravity, 'no-such-model'))
      .toBe(AntigravityProvider.getDefaultModel());
  });

  it('uses the new provider default when the old provider is missing', () => {
    expect(page.mapModelForProviderSwitch(undefined, antigravity, 'opus'))
      .toBe(AntigravityProvider.getDefaultModel());
  });

  it('uses the first model when the new provider flags no default', () => {
    const newP = { models: [{ id: 'x', tier: 'fast' }, { id: 'y', tier: 'balanced' }] };
    expect(page.mapModelForProviderSwitch(undefined, newP, 'opus')).toBe('x');
  });

  it('uses the new provider default when no model matches the tier', () => {
    const oldP = { models: [{ id: 'a', tier: 'premium' }] };
    const newP = { models: [{ id: 'x', tier: 'fast' }, { id: 'd', tier: 'balanced', default: true }] };
    expect(page.mapModelForProviderSwitch(oldP, newP, 'a')).toBe('d');
  });
});
