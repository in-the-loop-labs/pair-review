// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for what a BRAND-NEW council gets from the two config tabs: the
 * seeded provider/model pair (`setDefaultOrchestration`) and the auto-generated
 * name (`autoSaveIfDirty`).
 *
 * THE PAIR. Callers hand the tabs the output of `resolveProviderModelPair`,
 * which deliberately PRESERVES a configured alias and resolves against the raw
 * `/api/providers` array. The tabs assign that pair straight onto `<select>`
 * elements whose options are canonical ids of renderable providers only, so
 * EITHER half can select nothing — and an empty select makes
 * `_readConfigFromUI` drop the reviewer row (`if (provider && model)`), which
 * POSTs an empty voices list and 400s. `pair-review <pr> --model opus` →
 * analysis dialog → Council tab → Save As was a live instance of exactly that.
 * `setDefaultOrchestration` therefore canonicalizes both halves, which is why
 * `setProviders()` has to run first.
 *
 * THE NAME. The auto-save prefixes are 'Council' and 'Advanced' — the persisted
 * `type` column literals, so the name survives a badge rename (CouncilDropdown
 * renders type 'council' as the badge "Standard"). Only reachable when NO
 * council is selected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

require('../../public/js/utils/provider-map.js');
const { VoiceCentricConfigTab } = require('../../public/js/components/VoiceCentricConfigTab.js');
const { AdvancedConfigTab } = require('../../public/js/components/AdvancedConfigTab.js');

const CLAUDE = {
  id: 'claude',
  name: 'Claude',
  defaultModel: 'sonnet',
  models: [
    { id: 'sonnet-4.6', name: 'Sonnet 4.6', aliases: ['sonnet'], default: true },
    { id: 'opus-4.2', name: 'Opus 4.2', aliases: ['opus'] }
  ]
};
const ANTIGRAVITY = {
  id: 'antigravity',
  name: 'Antigravity',
  models: [{ id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (low)', default: true }]
};

const TABS = [
  {
    label: 'VoiceCentricConfigTab',
    TabClass: VoiceCentricConfigTab,
    expectedPrefix: 'Council',
    // Reads back the seeded pair through the config the tab would submit.
    pairFromConfig: (config) => config.voices[0]
  },
  {
    label: 'AdvancedConfigTab',
    TabClass: AdvancedConfigTab,
    expectedPrefix: 'Advanced',
    pairFromConfig: (config) => config.levels['1'].voices[0]
  }
];

/** A tab-like context carrying only what these two methods touch. */
function makeCtx(TabClass, providers) {
  return {
    providers,
    _defaultProvider: 'claude',
    _defaultModel: 'sonnet',
    _getProviderDefaultTimeout: TabClass.prototype._getProviderDefaultTimeout,
    _defaultConfig: TabClass.prototype._defaultConfig
  };
}

const setDefaults = (TabClass, providers, provider, model) => {
  const ctx = makeCtx(TabClass, providers);
  TabClass.prototype.setDefaultOrchestration.call(ctx, provider, model);
  return ctx;
};

beforeEach(() => {
  window.toast = { showWarning: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() };
});

afterEach(() => {
  delete window.toast;
});

for (const spec of TABS) {
  const { label, TabClass, expectedPrefix, pairFromConfig } = spec;

  describe(`${label}.setDefaultOrchestration`, () => {
    const providers = { claude: CLAUDE, antigravity: ANTIGRAVITY };

    it('canonicalizes a model alias to the id the <select> carries', () => {
      // `--model opus` → cliOverrides → /api/config.model_override → here.
      const ctx = setDefaults(TabClass, providers, 'claude', 'opus');

      expect(ctx._defaultProvider).toBe('claude');
      expect(ctx._defaultModel).toBe('opus-4.2');
    });

    it('leaves a canonical model alone', () => {
      const ctx = setDefaults(TabClass, providers, 'claude', 'sonnet-4.6');
      expect(ctx._defaultModel).toBe('sonnet-4.6');
    });

    it('falls back to a real provider AND its default model when the provider is missing', () => {
      // The provider half fails the same way: the pair is resolved against the
      // raw /api/providers array, but the tab renders buildProviderMap output
      // (which DROPS providers with no models).
      const ctx = setDefaults(TabClass, { antigravity: ANTIGRAVITY }, 'claude', 'opus');

      expect(ctx._defaultProvider).toBe('antigravity');
      // NOT 'opus'/'opus-4.2': a model id from a different provider selects
      // nothing either. And NOT the hardcoded 'sonnet' — claude is precisely
      // what went missing.
      expect(ctx._defaultModel).toBe('gemini-3.1-pro-low');
    });

    it('skips a provider reported unavailable', () => {
      // _populateProviderDropdown filters these out, so the id has no <option>.
      const withUnavailable = {
        claude: { ...CLAUDE, availability: { available: false } },
        antigravity: ANTIGRAVITY
      };
      const ctx = setDefaults(TabClass, withUnavailable, 'claude', 'opus');

      expect(ctx._defaultProvider).toBe('antigravity');
      expect(ctx._defaultModel).toBe('gemini-3.1-pro-low');
    });

    it('keeps the hardcoded seed when setProviders has not run yet', () => {
      // ORDERING: with no provider metadata there is nothing to canonicalize
      // against, so the arguments stand and empties fall back to claude/sonnet.
      const empty = setDefaults(TabClass, {}, null, null);
      expect(empty._defaultProvider).toBe('claude');
      expect(empty._defaultModel).toBe('sonnet');

      const passthrough = setDefaults(TabClass, {}, 'muse', 'muse-model');
      expect(passthrough._defaultProvider).toBe('muse');
      expect(passthrough._defaultModel).toBe('muse-model');
    });

    it('fills an empty model from the provider default rather than "sonnet"', () => {
      const ctx = setDefaults(TabClass, { antigravity: ANTIGRAVITY }, 'antigravity', null);
      expect(ctx._defaultModel).toBe('gemini-3.1-pro-low');
    });

    it('degrades to the previous behavior when window.ProviderMap is absent', () => {
      // Collaborators are resolved at CALL time; a page that has not loaded the
      // helper must still get a usable seed rather than a TypeError.
      const saved = window.ProviderMap;
      delete window.ProviderMap;
      try {
        const ctx = setDefaults(TabClass, providers, 'claude', 'opus');
        expect(ctx._defaultProvider).toBe('claude');
        expect(ctx._defaultModel).toBe('opus');
        expect(setDefaults(TabClass, providers, null, null)._defaultProvider).toBe('claude');
      } finally {
        window.ProviderMap = saved;
      }
    });

    it('seeds _defaultConfig with a pair the reviewer row can actually hold', () => {
      const ctx = setDefaults(TabClass, { antigravity: ANTIGRAVITY }, 'claude', 'opus');

      const voice = pairFromConfig(TabClass.prototype._defaultConfig.call(ctx));

      expect(voice.provider).toBe('antigravity');
      expect(voice.model).toBe('gemini-3.1-pro-low');
    });
  });

  describe(`${label}.autoSaveIfDirty (generated name)`, () => {
    function makeAutoSaveCtx(overrides = {}) {
      return {
        _isDirty: true,
        selectedCouncilId: null,
        councils: [],
        _readConfigFromUI: vi.fn(() => ({ marker: 'config' })),
        _validateConfig: vi.fn(() => ({ valid: true })),
        _postCouncil: vi.fn(async () => true),
        _formatTimestamp: TabClass.prototype._formatTimestamp,
        ...overrides
      };
    }

    it(`names an unsaved council "${expectedPrefix} <timestamp>"`, async () => {
      const ctx = makeAutoSaveCtx();

      await TabClass.prototype.autoSaveIfDirty.call(ctx);

      const [name] = ctx._postCouncil.mock.calls[0];
      // The prefix is the persisted `type` literal, not the badge label.
      expect(name).toMatch(
        new RegExp(`^${expectedPrefix} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`)
      );
    });

    it('prefers the selected council name over the prefix', async () => {
      const ctx = makeAutoSaveCtx({
        selectedCouncilId: 'c1',
        councils: [{ id: 'c1', name: 'Dream Team' }]
      });

      await TabClass.prototype.autoSaveIfDirty.call(ctx);

      expect(ctx._postCouncil.mock.calls[0][0]).toMatch(/^Dream Team \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });
}

describe('AdvancedConfigTab.autoSaveIfDirty (missing-council fallback)', () => {
  it('falls back to "Advanced", not "Config", when the selected id is gone', async () => {
    // Reachable after a failed loadCouncils leaves `councils = []` while an id
    // is still selected.
    const ctx = {
      _isDirty: true,
      selectedCouncilId: 'vanished',
      councils: [],
      _readConfigFromUI: vi.fn(() => ({ marker: 'config' })),
      _validateConfig: vi.fn(() => ({ valid: true })),
      _postCouncil: vi.fn(async () => true),
      _formatTimestamp: AdvancedConfigTab.prototype._formatTimestamp
    };

    await AdvancedConfigTab.prototype.autoSaveIfDirty.call(ctx);

    expect(ctx._postCouncil.mock.calls[0][0])
      .toMatch(/^Advanced \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
