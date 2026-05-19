// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const { getAdapter, adapters } = require('../../../src/external');
const githubAdapter = require('../../../src/external/github-adapter');

describe('external dispatcher', () => {
  it('getAdapter("github") returns the GitHub adapter', () => {
    const adapter = getAdapter('github');
    expect(adapter).toBe(githubAdapter);
    expect(adapter.name).toBe('github');
    expect(typeof adapter.fetchComments).toBe('function');
    expect(typeof adapter.mapComment).toBe('function');
  });

  it('getAdapter("unknown") throws with the source name in the message', () => {
    expect(() => getAdapter('unknown')).toThrow(
      /Unknown external comment source: unknown/
    );
  });

  it('getAdapter throws when called with an empty string', () => {
    expect(() => getAdapter('')).toThrow(
      /Unknown external comment source:/
    );
  });

  it('adapters registry exposes github by name', () => {
    expect(adapters.github).toBe(githubAdapter);
  });

  it('getAdapter("toString") throws (own-property guard against inherited members)', () => {
    // Regression: `adapters` is a plain object, so `adapters['toString']`
    // would resolve to `Object.prototype.toString` (a function) without
    // the hasOwnProperty guard. The route depends on this function
    // throwing for unknown sources.
    expect(() => getAdapter('toString')).toThrow(
      /Unknown external comment source: toString/
    );
  });

  it('getAdapter("__proto__") throws', () => {
    expect(() => getAdapter('__proto__')).toThrow(
      /Unknown external comment source: __proto__/
    );
  });

  it('getAdapter("hasOwnProperty") throws', () => {
    expect(() => getAdapter('hasOwnProperty')).toThrow(
      /Unknown external comment source: hasOwnProperty/
    );
  });

  it('getAdapter(non-string) throws', () => {
    expect(() => getAdapter(null)).toThrow(/Unknown external comment source:/);
    expect(() => getAdapter(undefined)).toThrow(/Unknown external comment source:/);
    expect(() => getAdapter(123)).toThrow(/Unknown external comment source:/);
  });
});
