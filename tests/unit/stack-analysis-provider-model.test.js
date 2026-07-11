// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for _resolveStackProviderModel() in src/routes/stack-analysis.js.
 *
 * Precedence: request body > CLI override (`--provider`/`--model`, threaded via
 * `cliOverrides` — there is no env-var side channel) > saved repo settings >
 * config default > legacy config key > hardcoded claude/opus. Both fields fall
 * through independently so a provider-only override does not force a default
 * Claude model onto it.
 */
import { describe, it, expect } from 'vitest';

const { _resolveStackProviderModel } = require('../../src/routes/stack-analysis.js');

describe('_resolveStackProviderModel', () => {
  it('request body wins over CLI override, repo settings, and config', () => {
    const result = _resolveStackProviderModel({
      reqProvider: 'claude',
      reqModel: 'opus',
      cliOverrides: { provider: 'antigravity', model: 'gemini-3.5-flash-low' },
      repoSettings: { default_provider: 'codex', default_model: 'gpt-5.5' },
      config: { default_provider: 'copilot', default_model: 'gpt-5' }
    });
    expect(result).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('honors the CLI model override alongside the provider override', () => {
    const result = _resolveStackProviderModel({
      cliOverrides: { provider: 'codex', model: 'gpt-5.5' },
      repoSettings: { default_provider: 'claude', default_model: 'opus' },
      config: { default_provider: 'antigravity', default_model: 'gemini-3.5-flash-low' }
    });
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('CLI override outranks saved repo settings for both provider and model', () => {
    const result = _resolveStackProviderModel({
      cliOverrides: { provider: 'codex', model: 'gpt-5.5' },
      repoSettings: { default_provider: 'claude', default_model: 'opus' }
    });
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('falls back to repo settings when there is no request body or CLI override', () => {
    const result = _resolveStackProviderModel({
      repoSettings: { default_provider: 'antigravity', default_model: 'gemini-3.5-flash-low' },
      config: {}
    });
    expect(result).toEqual({ provider: 'antigravity', model: 'gemini-3.5-flash-low' });
  });

  it('falls back to config default, then the legacy config key', () => {
    expect(
      _resolveStackProviderModel({ config: { default_provider: 'codex', default_model: 'gpt-5.5' } })
    ).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    expect(
      _resolveStackProviderModel({ config: { provider: 'copilot', model: 'gpt-5' } })
    ).toEqual({ provider: 'copilot', model: 'gpt-5' });
  });

  it('resolves provider and model independently (CLI-override model + repo-settings provider)', () => {
    const result = _resolveStackProviderModel({
      cliOverrides: { model: 'gpt-5.5' },
      repoSettings: { default_provider: 'codex', default_model: 'opus' }
    });
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('defaults to claude/opus when nothing is configured', () => {
    expect(_resolveStackProviderModel()).toEqual({ provider: 'claude', model: 'opus' });
    expect(_resolveStackProviderModel({ config: {} })).toEqual({ provider: 'claude', model: 'opus' });
  });
});
