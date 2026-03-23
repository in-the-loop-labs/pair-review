// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
const { getShaAbbrevLength, DEFAULT_SHA_ABBREV_LENGTH } = require('../../src/git/sha-abbrev');

function createMockDeps(overrides = {}) {
  return {
    execSync: vi.fn(() => { throw new Error('not mocked'); }),
    ...overrides
  };
}

describe('getShaAbbrevLength', () => {
  it('returns length of git rev-parse --short HEAD output', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => 'abc1234\n')
    });
    expect(getShaAbbrevLength('/repo', deps)).toBe(7);
  });

  it('returns longer length for large repos (e.g. 11 chars)', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => 'abc12345678\n')
    });
    expect(getShaAbbrevLength('/repo', deps)).toBe(11);
  });

  it('returns shorter length when core.abbrev is set low', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => 'abcd\n')
    });
    expect(getShaAbbrevLength('/repo', deps)).toBe(4);
  });

  it('passes repo path as cwd to execSync', () => {
    const execSync = vi.fn(() => 'abc1234\n');
    getShaAbbrevLength('/my/repo/path', { execSync });
    expect(execSync).toHaveBeenCalledWith('git rev-parse --short HEAD', {
      cwd: '/my/repo/path',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('returns default length when git command fails', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => { throw new Error('not a git repo'); })
    });
    expect(getShaAbbrevLength('/not-a-repo', deps)).toBe(DEFAULT_SHA_ABBREV_LENGTH);
  });

  it('returns default length when output is empty', () => {
    const deps = createMockDeps({
      execSync: vi.fn(() => '\n')
    });
    expect(getShaAbbrevLength('/repo', deps)).toBe(DEFAULT_SHA_ABBREV_LENGTH);
  });

  it('exports DEFAULT_SHA_ABBREV_LENGTH as 7', () => {
    expect(DEFAULT_SHA_ABBREV_LENGTH).toBe(7);
  });
});
