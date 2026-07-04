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
  { id: 'gemini-3.1-pro-low', default: true, tier: 'thorough' },
  { id: 'gemini-3.5-flash-low', tier: 'fast' }
];

describe('AnalysisConfigModal.selectModel guard', () => {
  it('keeps a model that belongs to the current provider', () => {
    const ctx = makeContext(ANTIGRAVITY_MODELS);
    AnalysisConfigModal.prototype.selectModel.call(ctx, 'gemini-3.5-flash-low');
    expect(ctx.selectedModel).toBe('gemini-3.5-flash-low');
  });

  it('falls back to the provider default when given a foreign model', () => {
    const ctx = makeContext(ANTIGRAVITY_MODELS);
    AnalysisConfigModal.prototype.selectModel.call(ctx, 'opus');
    expect(ctx.selectedModel).toBe('gemini-3.1-pro-low');
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
