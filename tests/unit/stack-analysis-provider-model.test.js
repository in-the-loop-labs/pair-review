// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for _resolveStackProviderModel() in src/routes/stack-analysis.js.
 *
 * Regression: the model line previously omitted the PAIR_REVIEW_MODEL env
 * fallback that the provider line already had. Because the CLI mirrors BOTH
 * --provider and --model into env vars, a UI-launched stack analysis started
 * from `pair-review 123 --provider codex --model gpt-5.5` resolved provider from
 * the env override but fell back to the repo/app default model — pairing a
 * non-default provider with a default Claude model. Both env vars must be
 * honored together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { _resolveStackProviderModel } = require('../../src/routes/stack-analysis.js');

describe('_resolveStackProviderModel', () => {
  const ORIGINAL_PROVIDER = process.env.PAIR_REVIEW_PROVIDER;
  const ORIGINAL_MODEL = process.env.PAIR_REVIEW_MODEL;

  beforeEach(() => {
    delete process.env.PAIR_REVIEW_PROVIDER;
    delete process.env.PAIR_REVIEW_MODEL;
  });

  afterEach(() => {
    if (ORIGINAL_PROVIDER === undefined) delete process.env.PAIR_REVIEW_PROVIDER;
    else process.env.PAIR_REVIEW_PROVIDER = ORIGINAL_PROVIDER;
    if (ORIGINAL_MODEL === undefined) delete process.env.PAIR_REVIEW_MODEL;
    else process.env.PAIR_REVIEW_MODEL = ORIGINAL_MODEL;
  });

  it('request body wins over env override, repo settings, and config', () => {
    process.env.PAIR_REVIEW_PROVIDER = 'antigravity';
    process.env.PAIR_REVIEW_MODEL = 'gemini-3.5-flash-low';
    const result = _resolveStackProviderModel({
      reqProvider: 'claude',
      reqModel: 'opus',
      repoSettings: { default_provider: 'codex', default_model: 'gpt-5.5' },
      config: { default_provider: 'copilot', default_model: 'gpt-5' }
    });
    expect(result).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('honors PAIR_REVIEW_MODEL alongside PAIR_REVIEW_PROVIDER (regression)', () => {
    process.env.PAIR_REVIEW_PROVIDER = 'codex';
    process.env.PAIR_REVIEW_MODEL = 'gpt-5.5';
    const result = _resolveStackProviderModel({
      repoSettings: { default_provider: 'claude', default_model: 'opus' },
      config: { default_provider: 'antigravity', default_model: 'gemini-3.5-flash-low' }
    });
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('env override outranks saved repo settings for both provider and model', () => {
    process.env.PAIR_REVIEW_PROVIDER = 'codex';
    process.env.PAIR_REVIEW_MODEL = 'gpt-5.5';
    const result = _resolveStackProviderModel({
      repoSettings: { default_provider: 'claude', default_model: 'opus' }
    });
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('falls back to repo settings when there is no request body or env override', () => {
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

  it('resolves provider and model independently (env model + repo-settings provider)', () => {
    process.env.PAIR_REVIEW_MODEL = 'gpt-5.5';
    const result = _resolveStackProviderModel({
      repoSettings: { default_provider: 'codex', default_model: 'opus' }
    });
    expect(result).toEqual({ provider: 'codex', model: 'gpt-5.5' });
  });

  it('defaults to claude/opus when nothing is configured', () => {
    expect(_resolveStackProviderModel()).toEqual({ provider: 'claude', model: 'opus' });
    expect(_resolveStackProviderModel({ config: {} })).toEqual({ provider: 'claude', model: 'opus' });
  });
});
