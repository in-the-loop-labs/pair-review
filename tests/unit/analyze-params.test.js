// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared auto-analyze intent relay (carryAnalyzeParams /
 * stripAnalyzeParams). These centralize the [analyze, analysisConfigId,
 * council, provider, model] bundle so it survives every browser hop between the
 * single-port delegation URL and the review page that consumes it.
 */
import { describe, it, expect } from 'vitest';

const {
  carryAnalyzeParams,
  stripAnalyzeParams,
  ANALYZE_PARAM_KEYS
} = require('../../public/js/utils/analyze-params.js');

const ORIGIN = 'http://localhost:7247';

describe('carryAnalyzeParams', () => {
  it('carries the full bundle from a query string onto a target URL', () => {
    const from = 'analyze=true&analysisConfigId=abc&provider=codex&model=gpt-5.5';
    const to = new URL('/pr/o/r/1', ORIGIN);
    carryAnalyzeParams(from, to);
    expect(to.searchParams.get('analyze')).toBe('true');
    expect(to.searchParams.get('analysisConfigId')).toBe('abc');
    expect(to.searchParams.get('provider')).toBe('codex');
    expect(to.searchParams.get('model')).toBe('gpt-5.5');
  });

  it('accepts a URLSearchParams source as well as a string', () => {
    const from = new URLSearchParams('analyze=true&provider=antigravity');
    const to = new URL('/local/42', ORIGIN);
    carryAnalyzeParams(from, to);
    expect(to.searchParams.get('analyze')).toBe('true');
    expect(to.searchParams.get('provider')).toBe('antigravity');
    expect(to.searchParams.get('model')).toBeNull();
  });

  it('carries the council selection so the "Reload PR" retry keeps a CLI --council', () => {
    // Regression guard: council is part of the bundle. If it were dropped, the
    // worktree-recovery retry link and the setup.html hops would silently fall
    // back to the repo/default analysis config instead of the chosen council.
    const from = 'analyze=true&council=security-council';
    const to = new URL('/pr/o/r/1', ORIGIN);
    carryAnalyzeParams(from, to);
    expect(to.searchParams.get('analyze')).toBe('true');
    expect(to.searchParams.get('council')).toBe('security-council');
  });

  it('carries only the params that are present (partial bundle)', () => {
    const to = new URL('/pr/o/r/1', ORIGIN);
    carryAnalyzeParams('analyze=true', to);
    expect(to.searchParams.get('analyze')).toBe('true');
    expect(to.searchParams.get('provider')).toBeNull();
    expect(to.searchParams.get('analysisConfigId')).toBeNull();
  });

  it('ignores empty-string values', () => {
    const to = new URL('/pr/o/r/1', ORIGIN);
    carryAnalyzeParams('analyze=true&provider=', to);
    expect(to.searchParams.get('analyze')).toBe('true');
    expect(to.searchParams.has('provider')).toBe(false);
  });

  it('does NOT carry setup-internal params like path', () => {
    const to = new URL('/local/42', ORIGIN);
    carryAnalyzeParams('path=%2Ftmp%2Frepo&analyze=true&provider=codex', to);
    expect(to.searchParams.has('path')).toBe(false);
    expect(to.searchParams.get('analyze')).toBe('true');
    expect(to.searchParams.get('provider')).toBe('codex');
  });

  it('preserves params already present on the target URL', () => {
    const to = new URL('/pr/o/r/1?existing=keep', ORIGIN);
    carryAnalyzeParams('provider=codex', to);
    expect(to.searchParams.get('existing')).toBe('keep');
    expect(to.searchParams.get('provider')).toBe('codex');
  });

  it('returns the target URL for chaining and is a no-op on a falsy target', () => {
    const to = new URL('/pr/o/r/1', ORIGIN);
    expect(carryAnalyzeParams('analyze=true', to)).toBe(to);
    expect(carryAnalyzeParams('analyze=true', null)).toBeNull();
  });
});

describe('stripAnalyzeParams', () => {
  it('removes the entire bundle while leaving other params intact', () => {
    const url = new URL('/pr/o/r/1?analyze=true&analysisConfigId=abc&council=c1&provider=codex&model=x&keep=1', ORIGIN);
    stripAnalyzeParams(url);
    for (const key of ANALYZE_PARAM_KEYS) {
      expect(url.searchParams.has(key)).toBe(false);
    }
    expect(url.searchParams.get('keep')).toBe('1');
  });

  it('is a no-op when none of the bundle params are present', () => {
    const url = new URL('/pr/o/r/1?keep=1', ORIGIN);
    stripAnalyzeParams(url);
    expect(url.searchParams.get('keep')).toBe('1');
  });

  it('returns the url for chaining and tolerates a falsy argument', () => {
    const url = new URL('/pr/o/r/1', ORIGIN);
    expect(stripAnalyzeParams(url)).toBe(url);
    expect(stripAnalyzeParams(null)).toBeNull();
  });
});

describe('carry + strip round-trip', () => {
  it('a carried bundle is fully removed by a subsequent strip', () => {
    const to = new URL('/pr/o/r/1', ORIGIN);
    carryAnalyzeParams('analyze=true&analysisConfigId=abc&council=c1&provider=codex&model=x', to);
    stripAnalyzeParams(to);
    expect(to.search).toBe('');
  });
});
