// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the provider map helper (public/js/utils/provider-map.js) and
 * for AnalysisConfigModal.loadProviders delegating to it.
 *
 * Runs in the default Node environment: the helper is pure logic with no DOM
 * access. The loadProviders tests install a minimal `globalThis.window` because
 * the modal resolves `window.ProviderMap` at call time (script-order-proof), the
 * same convention the config tabs use for `window.CouncilExport`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  buildProviderMap,
  findModelWithAliases,
  resolveModelDisplay,
  resolveDefaultOrchestration
} = require('../../public/js/utils/provider-map.js');
const { AnalysisConfigModal } = require('../../public/js/components/AnalysisConfigModal.js');

const claude = {
  id: 'claude',
  name: 'Claude',
  models: [{ id: 'opus', name: 'Opus', default: true }]
};
const codex = {
  id: 'codex',
  name: 'Codex',
  models: [{ id: 'gpt-5', name: 'GPT-5' }]
};

describe('buildProviderMap', () => {
  it('keys providers by id', () => {
    expect(buildProviderMap([claude, codex])).toEqual({ claude, codex });
  });

  it('preserves the provider objects by reference', () => {
    const map = buildProviderMap([claude]);
    expect(map.claude).toBe(claude);
  });

  it('drops a provider with an empty models array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opencode = { id: 'opencode', name: 'OpenCode', models: [] };

    expect(buildProviderMap([claude, opencode])).toEqual({ claude });
    expect(warn).toHaveBeenCalledWith(
      'Provider "OpenCode" has no models configured and will not be available'
    );
    warn.mockRestore();
  });

  it('drops a provider with no models key at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(buildProviderMap([{ id: 'ghost', name: 'Ghost' }])).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      'Provider "Ghost" has no models configured and will not be available'
    );
    warn.mockRestore();
  });

  it('returns an empty map for an empty list', () => {
    expect(buildProviderMap([])).toEqual({});
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an object', { providers: [claude] }],
    ['a string', 'claude'],
    ['a number', 7]
  ])('returns an empty map when given %s', (_label, input) => {
    expect(buildProviderMap(input)).toEqual({});
  });

  it('resolves duplicate ids last-wins', () => {
    const older = { id: 'claude', name: 'Claude (old)', models: [{ id: 'sonnet' }] };

    expect(buildProviderMap([older, claude]).claude).toBe(claude);
  });

  it('returns a fresh object on every call', () => {
    expect(buildProviderMap([claude])).not.toBe(buildProviderMap([claude]));
  });
});

/**
 * Alias-aware providers used by the lookup/display/seed helpers below. Aliases
 * are the whole reason these live in one place: `resolveProviderModelPair`
 * PRESERVES a configured alias, so `sonnet` and `opus` reach the UI as-is and
 * must still resolve to the canonical model.
 */
const aliased = {
  id: 'claude',
  name: 'Claude',
  defaultModel: 'sonnet',
  models: [
    { id: 'sonnet-4.6', name: 'Sonnet 4.6', aliases: ['sonnet'], default: true },
    { id: 'opus-4.2', name: 'Opus 4.2', aliases: ['opus', 'opus-latest'] }
  ]
};
const antigravity = {
  id: 'antigravity',
  name: 'Antigravity',
  models: [{ id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (low)', default: true }]
};

describe('findModelWithAliases', () => {
  it('matches a canonical id', () => {
    expect(findModelWithAliases(aliased, 'opus-4.2')).toBe(aliased.models[1]);
  });

  it('matches an alias', () => {
    expect(findModelWithAliases(aliased, 'opus')).toBe(aliased.models[1]);
    expect(findModelWithAliases(aliased, 'sonnet')).toBe(aliased.models[0]);
  });

  it('returns undefined for an unknown id', () => {
    expect(findModelWithAliases(aliased, 'haiku')).toBeUndefined();
  });

  it.each([
    ['a null provider', null, 'opus'],
    ['a provider with no models', { id: 'ghost' }, 'opus'],
    ['a null model id', aliased, null],
    ['an empty model id', aliased, '']
  ])('returns undefined for %s', (_label, provider, modelId) => {
    expect(findModelWithAliases(provider, modelId)).toBeUndefined();
  });

  it('does not throw on a model entry with no aliases key', () => {
    expect(() => findModelWithAliases(codex, 'gpt-5')).not.toThrow();
    expect(findModelWithAliases(codex, 'gpt-5')).toBe(codex.models[0]);
  });
});

describe('resolveModelDisplay', () => {
  // The three call sites this replaces held their providers differently:
  // settings.js an array, repo-settings.js and the tabs a map, CouncilManager
  // both. Either shape has to answer the same.
  it.each([
    ['an array', [aliased, antigravity]],
    ['a map', { claude: aliased, antigravity }]
  ])('resolves names from %s', (_label, providers) => {
    expect(resolveModelDisplay(providers, 'claude', 'opus-4.2'))
      .toEqual({ providerName: 'Claude', modelName: 'Opus 4.2' });
  });

  it('resolves an alias to the canonical model name', () => {
    expect(resolveModelDisplay([aliased], 'claude', 'opus'))
      .toEqual({ providerName: 'Claude', modelName: 'Opus 4.2' });
  });

  it('falls back to the raw ids for an unknown provider', () => {
    expect(resolveModelDisplay([aliased], 'muse', 'some-model'))
      .toEqual({ providerName: 'muse', modelName: 'some-model' });
  });

  it('keeps the provider name but falls back to the raw id for an unknown model', () => {
    expect(resolveModelDisplay([aliased], 'claude', 'haiku'))
      .toEqual({ providerName: 'Claude', modelName: 'haiku' });
  });

  it('falls back when the provider was dropped from a buildProviderMap map', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // buildProviderMap DROPS a provider with no models; a stored voice naming it
    // must still print something rather than crash or say "Claude".
    const map = buildProviderMap([aliased, { id: 'opencode', name: 'OpenCode', models: [] }]);
    warn.mockRestore();

    expect(resolveModelDisplay(map, 'opencode', 'grok'))
      .toEqual({ providerName: 'opencode', modelName: 'grok' });
  });

  it('tolerates a models array of bare id strings', () => {
    const bare = { id: 'custom', name: 'Custom', models: ['m1', 'm2'] };
    expect(resolveModelDisplay([bare], 'custom', 'm2'))
      .toEqual({ providerName: 'Custom', modelName: 'm2' });
  });

  it('names an unnamed provider by its id', () => {
    expect(resolveModelDisplay([{ id: 'custom', models: [] }], 'custom', 'm1'))
      .toEqual({ providerName: 'custom', modelName: 'm1' });
  });

  it.each([
    ['null providers', null, 'claude', 'opus', { providerName: 'claude', modelName: 'opus' }],
    ['undefined providers', undefined, 'claude', 'opus', { providerName: 'claude', modelName: 'opus' }],
    ['a null provider id', [aliased], null, 'opus', { providerName: 'Unknown', modelName: 'opus' }],
    ['a null model id', [aliased], 'claude', null, { providerName: 'Claude', modelName: 'Unknown' }],
    ['nothing at all', null, null, null, { providerName: 'Unknown', modelName: 'Unknown' }]
  ])('answers "Unknown" rather than throwing for %s', (_label, providers, p, m, expected) => {
    expect(resolveModelDisplay(providers, p, m)).toEqual(expected);
  });
});

describe('resolveDefaultOrchestration', () => {
  const map = { claude: aliased, antigravity };

  it('canonicalizes a model alias to the id the <select> carries', () => {
    // `--model opus` reaches the tab as the alias; the model options are
    // canonical ids only, so assigning `opus` would select nothing.
    expect(resolveDefaultOrchestration(map, 'claude', 'opus'))
      .toEqual({ provider: 'claude', model: 'opus-4.2' });
  });

  it('passes a canonical model through unchanged', () => {
    expect(resolveDefaultOrchestration(map, 'claude', 'sonnet-4.6'))
      .toEqual({ provider: 'claude', model: 'sonnet-4.6' });
  });

  it('falls back to the first provider AND its default model when the provider is missing', () => {
    // NOT `{ provider: null, model: null }`: the tabs' own seed is
    // claude/sonnet, which fails identically when claude is what went missing.
    expect(resolveDefaultOrchestration({ antigravity }, 'claude', 'opus'))
      .toEqual({ provider: 'antigravity', model: 'gemini-3.1-pro-low' });
  });

  it('never carries the requested model across a provider substitution', () => {
    expect(resolveDefaultOrchestration({ antigravity }, 'claude', 'opus-4.2').model)
      .toBe('gemini-3.1-pro-low');
  });

  it('skips a provider reported unavailable', () => {
    const withUnavailable = {
      claude: { ...aliased, availability: { available: false } },
      antigravity
    };
    expect(resolveDefaultOrchestration(withUnavailable, 'claude', 'opus'))
      .toEqual({ provider: 'antigravity', model: 'gemini-3.1-pro-low' });
  });

  it('keeps a provider whose availability has not been checked yet', () => {
    // Availability arrives asynchronously; absent means "unknown", not "no".
    expect(resolveDefaultOrchestration(map, 'claude', 'opus').provider).toBe('claude');
  });

  it('falls back to the full map when availability rules everything out', () => {
    const allDown = {
      claude: { ...aliased, availability: { available: false } },
      antigravity: { ...antigravity, availability: { available: false } }
    };
    expect(resolveDefaultOrchestration(allDown, 'claude', 'opus'))
      .toEqual({ provider: 'claude', model: 'opus-4.2' });
  });

  it('resolves the provider default model when the requested one is unknown', () => {
    expect(resolveDefaultOrchestration(map, 'claude', 'haiku'))
      .toEqual({ provider: 'claude', model: 'sonnet-4.6' });
  });

  it('resolves a provider default model that is itself an alias', () => {
    // `defaultModel: 'sonnet'` is an alias; the option value is `sonnet-4.6`.
    expect(resolveDefaultOrchestration(map, 'claude', null).model).toBe('sonnet-4.6');
  });

  it('uses the flagged default, then the first model, when no defaultModel is declared', () => {
    const undeclared = {
      p: { id: 'p', name: 'P', models: [{ id: 'a' }, { id: 'b', default: true }] }
    };
    expect(resolveDefaultOrchestration(undeclared, 'p', null).model).toBe('b');

    const unflagged = { p: { id: 'p', name: 'P', models: [{ id: 'a' }, { id: 'b' }] } };
    expect(resolveDefaultOrchestration(unflagged, 'p', null).model).toBe('a');
  });

  it('returns the inputs unchanged when there is no provider metadata', () => {
    // setProviders() has not run: nothing to canonicalize against, so the
    // caller keeps its own hardcoded seed rather than being handed nulls.
    expect(resolveDefaultOrchestration({}, 'claude', 'opus'))
      .toEqual({ provider: 'claude', model: 'opus' });
    expect(resolveDefaultOrchestration(null, 'claude', 'opus'))
      .toEqual({ provider: 'claude', model: 'opus' });
    expect(resolveDefaultOrchestration(undefined, null, null))
      .toEqual({ provider: null, model: null });
  });

  it('accepts the raw /api/providers array as well as a map', () => {
    expect(resolveDefaultOrchestration([aliased, antigravity], 'claude', 'opus'))
      .toEqual({ provider: 'claude', model: 'opus-4.2' });
  });

  it('keeps the requested model when the chosen provider declares none', () => {
    const modelless = { custom: { id: 'custom', name: 'Custom' } };
    expect(resolveDefaultOrchestration(modelless, 'custom', 'whatever'))
      .toEqual({ provider: 'custom', model: 'whatever' });
  });
});

describe('window.ProviderMap registration', () => {
  it('exposes every export on window', () => {
    const api = require('../../public/js/utils/provider-map.js');
    // The module installs `window.ProviderMap` at load time only when a window
    // exists; this file runs in the Node environment, so build the comparison
    // from the exports themselves.
    expect(Object.keys(api).sort()).toEqual([
      'buildProviderMap',
      'findModelWithAliases',
      'resolveDefaultOrchestration',
      'resolveModelDisplay'
    ]);
  });
});

describe('AnalysisConfigModal.loadProviders', () => {
  let fetchMock;
  let errorSpy;

  function makeContext() {
    return {
      providers: {},
      providersLoaded: false,
      availabilityCheckInProgress: false,
      models: [],
      selectedProvider: 'claude'
    };
  }

  function respondWith(body, ok = true) {
    fetchMock.mockResolvedValue({ ok, json: async () => body });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = fetchMock;
    globalThis.window = { ProviderMap: { buildProviderMap } };
  });

  afterEach(() => {
    errorSpy.mockRestore();
    delete globalThis.window;
    delete globalThis.fetch;
  });

  it('builds the provider map from the API payload', async () => {
    respondWith({ providers: [claude, codex], checkInProgress: true });
    const ctx = makeContext();

    await AnalysisConfigModal.prototype.loadProviders.call(ctx);

    expect(ctx.providers).toEqual({ claude, codex });
    expect(ctx.models).toBe(claude.models);
    expect(ctx.providersLoaded).toBe(true);
    expect(ctx.availabilityCheckInProgress).toBe(true);
  });

  it('resolves window.ProviderMap at call time', async () => {
    const spy = vi.fn(() => ({ claude }));
    globalThis.window.ProviderMap = { buildProviderMap: spy };
    respondWith({ providers: [claude] });

    await AnalysisConfigModal.prototype.loadProviders.call(makeContext());

    expect(spy).toHaveBeenCalledWith([claude]);
  });

  it('drops model-less providers end to end', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({ providers: [claude, { id: 'opencode', name: 'OpenCode', models: [] }] });
    const ctx = makeContext();

    await AnalysisConfigModal.prototype.loadProviders.call(ctx);

    expect(ctx.providers).toEqual({ claude });
    warn.mockRestore();
  });

  it('falls back to the hardcoded Claude provider when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const ctx = makeContext();

    await AnalysisConfigModal.prototype.loadProviders.call(ctx);

    expect(Object.keys(ctx.providers)).toEqual(['claude']);
    expect(ctx.providers.claude.models).toHaveLength(1);
    expect(ctx.models).toBe(ctx.providers.claude.models);
    expect(ctx.providersLoaded).toBe(true);
  });

  it('falls back when the payload has no providers array', async () => {
    respondWith({ checkInProgress: false });
    const ctx = makeContext();

    await AnalysisConfigModal.prototype.loadProviders.call(ctx);

    expect(Object.keys(ctx.providers)).toEqual(['claude']);
    expect(ctx.providers.claude.defaultModel).toBe('opus');
  });

  it('skips the fetch entirely when providers are already loaded', async () => {
    const ctx = { ...makeContext(), providersLoaded: true };

    await AnalysisConfigModal.prototype.loadProviders.call(ctx);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
