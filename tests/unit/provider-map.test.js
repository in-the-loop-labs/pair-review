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

const { buildProviderMap } = require('../../public/js/utils/provider-map.js');
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
