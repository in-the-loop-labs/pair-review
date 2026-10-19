// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for AnalysisConfigModal.selectModel()'s guard against foreign
 * model ids. The modal is seeded with provider/model defaults resolved from
 * different scopes, so it can be asked to select a model that does not belong
 * to the current provider (e.g. 'opus' while the provider is 'antigravity'). The
 * guard must fall back to the provider's default rather than storing the
 * invalid id (which would leave no model card selected and submit a bad pair).
 */
import { describe, it, expect } from 'vitest';

const { AnalysisConfigModal } = require('../../public/js/components/AnalysisConfigModal.js');

// A minimal stand-in for the modal's DOM so we can exercise selectModel() in
// isolation without constructing the full modal (which needs jsdom + the tab
// classes). selectModel only reads/writes a few nodes.
function makeFakeModal() {
  const noopCard = { classList: { toggle() {} }, dataset: {} };
  return {
    querySelectorAll: () => ({ forEach() {} }),
    querySelector: () => null
  };
}

function makeContext(models) {
  return {
    models,
    selectedModel: null,
    modal: makeFakeModal(),
    _updateEnabledLevels() {}
  };
}

const ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.8-flash-high', default: true, tier: 'thorough' },
  { id: 'gemini-3.8-flash-medium', tier: 'balanced' },
  { id: 'gemini-3.8-flash-low', tier: 'fast' }
];

describe('AnalysisConfigModal.selectModel guard', () => {
  it('keeps a model that belongs to the current provider', () => {
    const ctx = makeContext(ANTIGRAVITY_MODELS);
    AnalysisConfigModal.prototype.selectModel.call(ctx, 'gemini-3.8-flash-low');
    expect(ctx.selectedModel).toBe('gemini-3.8-flash-low');
  });

  it('falls back to the provider default when given a foreign model', () => {
    const ctx = makeContext(ANTIGRAVITY_MODELS);
    AnalysisConfigModal.prototype.selectModel.call(ctx, 'opus');
    expect(ctx.selectedModel).toBe('gemini-3.8-flash-high');
  });

  it('falls back to the first model when no model is flagged default', () => {
    const ctx = makeContext([{ id: 'a' }, { id: 'b' }]);
    AnalysisConfigModal.prototype.selectModel.call(ctx, 'opus');
    expect(ctx.selectedModel).toBe('a');
  });

  it('does not crash when the provider has no models loaded yet', () => {
    const ctx = makeContext([]);
    AnalysisConfigModal.prototype.selectModel.call(ctx, 'opus');
    // Nothing to validate against — id passes through unchanged.
    expect(ctx.selectedModel).toBe('opus');
  });
});

describe('AnalysisConfigModal.selectProvider tier mapping', () => {
  // Real catalogs, so a reorder of the provider arrays is caught here too.
  const ClaudeProvider = require('../../src/ai/claude-provider.js');
  const AntigravityProvider = require('../../src/ai/antigravity-provider.js');

  function makeSwitchContext(providers, selectedModel) {
    return {
      providers,
      models: [],
      selectedProvider: null,
      selectedModel,
      modal: makeFakeModal(),
      renderModelCards() {},
      // Real selectModel: its foreign-id guard runs after the tier mapping.
      selectModel: AnalysisConfigModal.prototype.selectModel,
      _updateEnabledLevels() {},
      _updateExcludePreviousState() {}
    };
  }

  function catalogs(extra = {}) {
    return {
      claude: { id: 'claude', models: ClaudeProvider.getModels() },
      antigravity: { id: 'antigravity', models: AntigravityProvider.getModels() },
      ...extra
    };
  }

  it('maps a thorough Claude model to the Antigravity default, not plan-gated Argon', () => {
    const thoroughClaude = ClaudeProvider.getModels().find(m => m.tier === 'thorough');
    const ctx = makeSwitchContext(catalogs(), thoroughClaude.id);
    AnalysisConfigModal.prototype.selectProvider.call(ctx, 'antigravity');
    expect(ctx.selectedModel).toBe('gemini-3.8-flash-high');
  });

  it('prefers the default within the tier even when a non-default leads that tier', () => {
    const ctx = makeSwitchContext({
      a: { id: 'a', models: [{ id: 'a-thorough', tier: 'thorough' }] },
      b: { id: 'b', models: [
        { id: 'b-gated', tier: 'thorough' },
        { id: 'b-default', tier: 'thorough', default: true },
        { id: 'b-fast', tier: 'fast' }
      ] }
    }, 'a-thorough');
    AnalysisConfigModal.prototype.selectProvider.call(ctx, 'b');
    expect(ctx.selectedModel).toBe('b-default');
  });

  it('falls back to the first model of the tier when the default is in another tier', () => {
    const ctx = makeSwitchContext({
      a: { id: 'a', models: [{ id: 'a-fast', tier: 'fast' }] },
      b: { id: 'b', models: [
        { id: 'b-thorough', tier: 'thorough', default: true },
        { id: 'b-fast-1', tier: 'fast' },
        { id: 'b-fast-2', tier: 'fast' }
      ] }
    }, 'a-fast');
    AnalysisConfigModal.prototype.selectProvider.call(ctx, 'b');
    expect(ctx.selectedModel).toBe('b-fast-1');
  });

  it('uses the provider default when no model matches the tier', () => {
    const ctx = makeSwitchContext({
      a: { id: 'a', models: [{ id: 'a-premium', tier: 'premium' }] },
      b: { id: 'b', models: [{ id: 'b-x', tier: 'fast' }, { id: 'b-default', tier: 'balanced', default: true }] }
    }, 'a-premium');
    AnalysisConfigModal.prototype.selectProvider.call(ctx, 'b');
    expect(ctx.selectedModel).toBe('b-default');
  });
});
