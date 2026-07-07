// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for PRManager._buildDefaultAnalysisConfig().
 *
 * This method builds the analysis config used by auto-analyze (--ai) when
 * no modal interaction occurs.  It must honour the repository's default
 * provider, model, and council settings so that --ai uses the true repo
 * default rather than hard-coding 'claude'/'opus'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import the actual PRManager class from production code
const { PRManager } = require('../../public/js/pr.js');
const {
  resolveProviderModelPair,
  buildProviderModelScopes,
  hasProviderModelOverride
} = require('../../public/js/utils/provider-model.js');
const {
  carryAnalyzeParams,
  stripAnalyzeParams
} = require('../../public/js/utils/analyze-params.js');
const { URLSearchParams: NativeURLSearchParams } = require('url');

// Provider metadata used to resolve a matched provider/model pair. Mirrors the
// shape of /api/providers (id, models, defaultModel).
const PROVIDERS = [
  { id: 'claude', defaultModel: 'opus', models: [{ id: 'opus' }, { id: 'sonnet-4.6' }, { id: 'haiku' }] },
  { id: 'antigravity', defaultModel: 'gemini-3.1-pro-low', models: [{ id: 'gemini-3.1-pro-low' }, { id: 'pro' }, { id: 'gemini-3.5-flash-low' }] },
  { id: 'pi', defaultModel: 'multi-model', models: [{ id: 'multi-model' }] }
];

let saved;

beforeEach(() => {
  vi.resetAllMocks();

  // Save original globalThis values so we can restore them in afterEach
  saved = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    history: globalThis.history,
    MutationObserver: globalThis.MutationObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
    URLSearchParams: globalThis.URLSearchParams,
    location: globalThis.location,
  };

  globalThis.window = globalThis;
  globalThis.resolveProviderModelPair = resolveProviderModelPair;
  globalThis.buildProviderModelScopes = buildProviderModelScopes;
  globalThis.hasProviderModelOverride = hasProviderModelOverride;
  globalThis.carryAnalyzeParams = carryAnalyzeParams;
  globalThis.stripAnalyzeParams = stripAnalyzeParams;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {},
      getAttribute() {},
      appendChild() {},
      addEventListener() {},
      style: {},
      dataset: {},
    }),
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  globalThis.history = { replaceState() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.URLSearchParams = class { get() { return null; } };

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.window = saved.window;
  globalThis.document = saved.document;
  globalThis.localStorage = saved.localStorage;
  globalThis.fetch = saved.fetch;
  globalThis.history = saved.history;
  globalThis.MutationObserver = saved.MutationObserver;
  globalThis.IntersectionObserver = saved.IntersectionObserver;
  globalThis.URLSearchParams = saved.URLSearchParams;
  globalThis.location = saved.location;
  delete globalThis.resolveProviderModelPair;
  delete globalThis.buildProviderModelScopes;
  delete globalThis.hasProviderModelOverride;
  delete globalThis.carryAnalyzeParams;
  delete globalThis.stripAnalyzeParams;

  vi.restoreAllMocks();
});

describe('PRManager._buildDefaultAnalysisConfig', () => {
  let manager;

  beforeEach(() => {
    // Construct with minimal state — we only need the prototype method
    manager = Object.create(PRManager.prototype);
    // Provider metadata is resolved via _getProvidersInfo(); stub it so the
    // matched-pair resolver has real metadata without hitting /api/providers.
    manager._getProvidersInfo = vi.fn(() => Promise.resolve(PROVIDERS));
    // Default: fetch returns empty council (no config/name)
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ council: { config: null, name: null } }),
    }));
  });

  it('returns single-provider defaults when no repo settings exist', async () => {
    const config = await manager._buildDefaultAnalysisConfig(null, {});
    expect(config).toEqual({
      provider: 'claude',
      model: 'opus',
      customInstructions: null,
    });
  });

  it('uses app config defaults when no repo settings exist', async () => {
    const config = await manager._buildDefaultAnalysisConfig(null, {}, {
      default_provider: 'pi',
      default_model: 'multi-model',
    });
    expect(config).toEqual({
      provider: 'pi',
      model: 'multi-model',
      customInstructions: null,
    });
  });

  it('uses repo default_provider and default_model', async () => {
    const repoSettings = { default_provider: 'antigravity', default_model: 'pro' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, {
      default_provider: 'pi',
      default_model: 'multi-model',
    });
    expect(config).toEqual({
      provider: 'antigravity',
      model: 'pro',
      customInstructions: null,
    });
  });

  it('derives the model from the provider when the repo overrides only the provider', async () => {
    // Repo overrides the provider but not the model; the app default model
    // ('opus') belongs to a different provider. The pair must NOT be mixed —
    // the model is derived from antigravity's own default.
    const repoSettings = { default_provider: 'antigravity' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, {
      default_provider: 'claude',
      default_model: 'opus',
    });
    expect(config.provider).toBe('antigravity');
    expect(config.model).toBe('gemini-3.1-pro-low');
    expect(config.model).not.toBe('opus');
  });

  it('passes through an explicitly provided providersInfo without fetching', async () => {
    const repoSettings = { default_provider: 'antigravity', default_model: 'pro' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, {}, PROVIDERS);
    expect(config).toEqual({ provider: 'antigravity', model: 'pro', customInstructions: null });
    expect(manager._getProvidersInfo).not.toHaveBeenCalled();
  });

  it('returns council config when default_tab is "council" with a council ID', async () => {
    const councilData = { config: { voices: ['a'], levels: { 1: true } }, name: 'My Council' };
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ council: councilData }),
    }));

    const repoSettings = { default_tab: 'council', default_council_id: 'abc-123' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});
    expect(config).toEqual({
      isCouncil: true,
      councilId: 'abc-123',
      councilConfig: councilData.config,
      councilName: 'My Council',
      configType: 'council',
      customInstructions: null,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/councils/abc-123');
  });

  it('returns council config when default_tab is "advanced" with a council ID', async () => {
    const councilData = { config: { voices: ['b'], levels: { 1: true } }, name: 'Adv Council' };
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ council: councilData }),
    }));

    const repoSettings = { default_tab: 'advanced', default_council_id: 'xyz-789' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});
    expect(config).toEqual({
      isCouncil: true,
      councilId: 'xyz-789',
      councilConfig: councilData.config,
      councilName: 'Adv Council',
      configType: 'advanced',
      customInstructions: null,
    });
  });

  it('falls back to single provider when default_tab is "council" but no council ID exists', async () => {
    const repoSettings = { default_tab: 'council', default_provider: 'openai', default_model: 'gpt-4o' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});
    expect(config).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      customInstructions: null,
    });
  });

  it('uses last_council_id from reviewSettings when repo has no default_council_id', async () => {
    const councilData = { config: { levels: {} }, name: 'Review Council' };
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ council: councilData }),
    }));

    const repoSettings = { default_tab: 'advanced' };
    const reviewSettings = { last_council_id: 'review-council-1' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, reviewSettings);
    expect(config).toEqual({
      isCouncil: true,
      councilId: 'review-council-1',
      councilConfig: councilData.config,
      councilName: 'Review Council',
      configType: 'advanced',
      customInstructions: null,
    });
  });

  it('prefers repo default_council_id over reviewSettings last_council_id', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ council: { config: {}, name: 'Repo' } }),
    }));

    const repoSettings = { default_tab: 'council', default_council_id: 'repo-council' };
    const reviewSettings = { last_council_id: 'old-council' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, reviewSettings);
    expect(config.councilId).toBe('repo-council');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/councils/repo-council');
  });

  it('falls back to defaults when default_tab is "single"', async () => {
    const repoSettings = { default_tab: 'single', default_council_id: 'should-ignore' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});
    expect(config.isCouncil).toBeUndefined();
    expect(config.provider).toBe('claude');
    // Should NOT fetch council config when tab is 'single'
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('handles undefined reviewSettings gracefully', async () => {
    const config = await manager._buildDefaultAnalysisConfig(null, undefined);
    expect(config).toEqual({
      provider: 'claude',
      model: 'opus',
      customInstructions: null,
    });
  });

  it('handles council fetch failure gracefully', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('network error')));

    const repoSettings = { default_tab: 'council', default_council_id: 'abc-123' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});
    // Should still return council config, just with null councilConfig
    expect(config).toEqual({
      isCouncil: true,
      councilId: 'abc-123',
      councilConfig: null,
      councilName: null,
      configType: 'council',
      customInstructions: null,
    });
  });

  it('handles council fetch returning non-ok response', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));

    const repoSettings = { default_tab: 'advanced', default_council_id: 'gone-council' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});
    expect(config.councilConfig).toBeNull();
    expect(config.councilName).toBeNull();
    expect(config.isCouncil).toBe(true);
  });

  it('does not forward custom_instructions from reviewSettings', async () => {
    const reviewSettings = { custom_instructions: 'Be extra strict' };
    const config = await manager._buildDefaultAnalysisConfig(null, reviewSettings);
    expect(config.customInstructions).toBeNull();
  });

  it('honors a ?council=<id> URL param with highest priority (CLI --council)', async () => {
    // Simulate the CLI-provided ?council=<id> param via the URLSearchParams stub.
    globalThis.URLSearchParams = class { get(k) { return k === 'council' ? 'url-council-id' : null; } };
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        council: {
          id: 'url-council-id',
          name: 'URL Council',
          type: 'council',
          config: { voices: [{ provider: 'claude', model: 'opus' }], levels: { '1': true } },
        },
      }),
    }));

    // Repo defaults point at a single-model config; the URL param must still win.
    const repoSettings = { default_tab: 'single', default_provider: 'antigravity', default_model: 'pro' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {});

    expect(config.isCouncil).toBe(true);
    expect(config.councilId).toBe('url-council-id');
    expect(config.councilName).toBe('URL Council');
    expect(config.configType).toBe('council'); // derived from the council's own type
    expect(config.councilConfig).toEqual({ voices: [{ provider: 'claude', model: 'opus' }], levels: { '1': true } });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/councils/url-council-id');
  });

  it('falls back to default selection when the URL council fetch fails', async () => {
    globalThis.URLSearchParams = class { get(k) { return k === 'council' ? 'bad-id' : null; } };
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));

    const config = await manager._buildDefaultAnalysisConfig(null, {});
    // Unknown URL council -> not forced into council mode; single-provider default.
    expect(config.isCouncil).toBeUndefined();
    expect(config.provider).toBe('claude');
    expect(config.model).toBe('opus');
  });

  // ------------------------------------------------------------------
  // CLI/env override (PAIR_REVIEW_PROVIDER via /api/config provider_override,
  // or the single-port delegation URL). These drive the REAL auto-analyze
  // request shape: the pair is default-filled from an env-aware source, not
  // explicitly chosen — the path that carried the original bug.
  // ------------------------------------------------------------------
  it('lets an env override (appConfig.provider_override) outrank saved repo settings', async () => {
    const repoSettings = { default_provider: 'antigravity', default_model: 'pro' };
    const appConfig = {
      default_provider: 'claude',
      default_model: 'opus',
      provider_override: 'pi',
      model_override: 'multi-model'
    };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, appConfig, PROVIDERS);
    expect(config).toEqual({ provider: 'pi', model: 'multi-model', customInstructions: null });
  });

  it('derives the model from a provider-only env override', async () => {
    const repoSettings = { default_provider: 'claude', default_model: 'opus' };
    const appConfig = { default_provider: 'claude', default_model: 'opus', provider_override: 'antigravity' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, appConfig, PROVIDERS);
    expect(config.provider).toBe('antigravity');
    expect(config.model).toBe('gemini-3.1-pro-low');
  });

  it('lets a per-invocation (delegation URL) override outrank both repo settings and env override', async () => {
    const repoSettings = { default_provider: 'antigravity', default_model: 'pro' };
    const appConfig = { default_provider: 'claude', default_model: 'opus', provider_override: 'claude', model_override: 'opus' };
    const urlOverride = { provider: 'pi', model: 'multi-model' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, appConfig, PROVIDERS, urlOverride);
    expect(config).toEqual({ provider: 'pi', model: 'multi-model', customInstructions: null });
  });

  it('bypasses a council default and forces single-provider when an env override is active', async () => {
    // Repo default is a council, but --provider names a single provider — the
    // override must win (council is incompatible with a single provider).
    const councilFetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ council: { config: {}, name: 'C' } }),
    }));
    globalThis.fetch = councilFetch;

    const repoSettings = { default_tab: 'council', default_council_id: 'abc-123' };
    const appConfig = { provider_override: 'antigravity' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, appConfig, PROVIDERS);
    expect(config.isCouncil).toBeUndefined();
    expect(config.provider).toBe('antigravity');
    expect(config.model).toBe('gemini-3.1-pro-low');
    // Must NOT fetch council config when the override forces single-provider.
    expect(councilFetch).not.toHaveBeenCalled();
  });

  it('bypasses a council default when a delegation-URL override is active', async () => {
    const councilFetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ council: { config: {}, name: 'C' } }),
    }));
    globalThis.fetch = councilFetch;

    const repoSettings = { default_tab: 'advanced', default_council_id: 'xyz-789' };
    const config = await manager._buildDefaultAnalysisConfig(
      repoSettings, {}, {}, PROVIDERS, { provider: 'pi', model: 'multi-model' }
    );
    expect(config).toEqual({ provider: 'pi', model: 'multi-model', customInstructions: null });
    expect(councilFetch).not.toHaveBeenCalled();
  });

  it('still runs the council default when NO override is active', async () => {
    const councilData = { config: { voices: ['a'] }, name: 'My Council' };
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ council: councilData }),
    }));
    const repoSettings = { default_tab: 'council', default_council_id: 'abc-123' };
    const config = await manager._buildDefaultAnalysisConfig(repoSettings, {}, {}, PROVIDERS);
    expect(config.isCouncil).toBe(true);
    expect(config.councilId).toBe('abc-123');
  });
});

describe('PRManager.showWorktreeNotFoundError', () => {
  it('preserves analysisConfigId in the reload link for auto-analysis setup', () => {
    const container = { innerHTML: '', style: {} };
    globalThis.document.getElementById = vi.fn((id) => id === 'pr-container' ? container : null);
    globalThis.URLSearchParams = NativeURLSearchParams;
    globalThis.window.location = { search: '?analyze=true&analysisConfigId=bulk-config-id' };

    const manager = Object.create(PRManager.prototype);
    manager._autoAnalyzeRequested = true;
    manager.escapeHtml = (value) => value;
    manager.resetButton = vi.fn();

    manager.showWorktreeNotFoundError('owner', 'repo', 123);

    expect(container.innerHTML).toContain('/pr/owner/repo/123?analyze=true&analysisConfigId=bulk-config-id');
    expect(manager.resetButton).toHaveBeenCalled();
  });

  it('preserves a delegated provider/model override in the reload link', () => {
    const container = { innerHTML: '', style: {} };
    globalThis.document.getElementById = vi.fn((id) => id === 'pr-container' ? container : null);
    globalThis.URLSearchParams = NativeURLSearchParams;
    globalThis.window.location = { search: '?analyze=true&provider=codex&model=gpt-5.5' };

    const manager = Object.create(PRManager.prototype);
    manager._autoAnalyzeRequested = true;
    manager.escapeHtml = (value) => value;
    manager.resetButton = vi.fn();

    manager.showWorktreeNotFoundError('owner', 'repo', 123);

    expect(container.innerHTML).toContain('provider=codex');
    expect(container.innerHTML).toContain('model=gpt-5.5');
  });

  it('does not add analyze params when not arriving via auto-analyze', () => {
    const container = { innerHTML: '', style: {} };
    globalThis.document.getElementById = vi.fn((id) => id === 'pr-container' ? container : null);
    globalThis.URLSearchParams = NativeURLSearchParams;
    globalThis.window.location = { search: '?analyze=true&provider=codex' };

    const manager = Object.create(PRManager.prototype);
    manager._autoAnalyzeRequested = false;
    manager.escapeHtml = (value) => value;
    manager.resetButton = vi.fn();

    manager.showWorktreeNotFoundError('owner', 'repo', 123);

    expect(container.innerHTML).toContain('/pr/owner/repo/123"');
    expect(container.innerHTML).not.toContain('provider=codex');
  });
});
