// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the council-tab default config and pending-default-council
 * restoration. These guard two regressions introduced by the per-open reset():
 *
 *  1. AdvancedConfigTab._defaultConfig() must seed one reviewer voice per enabled
 *     level. An empty voices array made reset()->_applyConfigToUI() wipe the
 *     seeded rows, producing a council the server rejects ("voices must be a
 *     non-empty array when enabled").
 *  2. setDefaultCouncilId() must re-apply the pending default immediately when
 *     councils are already loaded (cached reopen of the reused modal), otherwise
 *     the saved/default council is silently dropped onto a blank "+ New Council".
 */
import { describe, it, expect, vi } from 'vitest';

const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');

describe('AdvancedConfigTab._defaultConfig', () => {
  function makeCtx(overrides = {}) {
    return {
      _defaultProvider: 'antigravity',
      _defaultModel: 'gemini-3.1-pro-low',
      _getProviderDefaultTimeout: () => 123456,
      ...overrides
    };
  }

  it('seeds exactly one voice per enabled level using the default provider/model', () => {
    const ctx = makeCtx();
    const config = AdvancedConfigTab.prototype._defaultConfig.call(ctx);

    for (const level of ['1', '2', '3']) {
      expect(config.levels[level].enabled).toBe(true);
      expect(config.levels[level].voices).toHaveLength(1);
      expect(config.levels[level].voices[0]).toEqual({
        provider: 'antigravity',
        model: 'gemini-3.1-pro-low',
        tier: 'balanced',
        timeout: 123456
      });
    }
  });

  it('produces a consolidation entry matching the default provider/model', () => {
    const ctx = makeCtx();
    const config = AdvancedConfigTab.prototype._defaultConfig.call(ctx);
    expect(config.consolidation).toEqual({
      provider: 'antigravity',
      model: 'gemini-3.1-pro-low',
      tier: 'balanced',
      timeout: 123456
    });
  });

  it('uses distinct voice objects per level (no shared reference)', () => {
    const ctx = makeCtx();
    const config = AdvancedConfigTab.prototype._defaultConfig.call(ctx);
    expect(config.levels['1'].voices[0]).not.toBe(config.levels['2'].voices[0]);

    // Mutating one level's voice must not bleed into another.
    config.levels['1'].voices[0].model = 'mutated';
    expect(config.levels['2'].voices[0].model).toBe('gemini-3.1-pro-low');
  });

  it('falls back to claude/sonnet when no default provider/model is set', () => {
    const ctx = makeCtx({ _defaultProvider: undefined, _defaultModel: undefined });
    const config = AdvancedConfigTab.prototype._defaultConfig.call(ctx);
    expect(config.levels['1'].voices[0].provider).toBe('claude');
    expect(config.levels['1'].voices[0].model).toBe('sonnet');
    expect(config.consolidation.provider).toBe('claude');
    expect(config.consolidation.model).toBe('sonnet');
  });
});

describe.each([
  ['AdvancedConfigTab', AdvancedConfigTab],
  ['VoiceCentricConfigTab', VoiceCentricConfigTab]
])('%s.setDefaultCouncilId cached-reopen restore', (_name, TabClass) => {
  function makeCtx(overrides = {}) {
    return {
      _injected: true,
      _councilsLoaded: false,
      _renderCouncilSelector: vi.fn(),
      ...overrides
    };
  }

  it('stores the pending default council id', () => {
    const ctx = makeCtx();
    TabClass.prototype.setDefaultCouncilId.call(ctx, 'council-42');
    expect(ctx._pendingDefaultCouncilId).toBe('council-42');
  });

  it('re-renders the selector when councils are already loaded (cached reopen)', () => {
    const ctx = makeCtx({ _councilsLoaded: true });
    TabClass.prototype.setDefaultCouncilId.call(ctx, 'council-42');
    expect(ctx._renderCouncilSelector).toHaveBeenCalledTimes(1);
  });

  it('does not re-render before the first council load (selector applies it then)', () => {
    const ctx = makeCtx({ _councilsLoaded: false });
    TabClass.prototype.setDefaultCouncilId.call(ctx, 'council-42');
    expect(ctx._renderCouncilSelector).not.toHaveBeenCalled();
  });

  it('does not re-render before the panel is injected', () => {
    const ctx = makeCtx({ _councilsLoaded: true, _injected: false });
    TabClass.prototype.setDefaultCouncilId.call(ctx, 'council-42');
    expect(ctx._renderCouncilSelector).not.toHaveBeenCalled();
  });
});
