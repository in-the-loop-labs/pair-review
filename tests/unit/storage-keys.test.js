// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the shared storage-key helpers. These keys are written by the
 * index/bulk page and read back by the PR page, so the encoding must be stable
 * and byte-accurate for multibyte repo names.
 */
import { describe, it, expect } from 'vitest';

const { encodeBase64Utf8, getRepoStorageKey } = require('../../public/js/utils/storage-keys.js');

// Independent oracle (Node Buffer) — a different implementation than the
// production TextEncoder + btoa path, so this is a real cross-check, not a copy.
function oracleBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

describe('encodeBase64Utf8', () => {
  it('matches an independent UTF-8 base64 implementation', () => {
    for (const value of ['owner/repo', 'a-b_c.d/e', 'café/naïve', '日本語/repo', 'a/b']) {
      expect(encodeBase64Utf8(value)).toBe(oracleBase64(value));
    }
  });
});

describe('getRepoStorageKey', () => {
  it('builds a prefixed key with padding stripped', () => {
    const key = getRepoStorageKey('pair-review-tab', 'owner', 'repo');
    expect(key).toBe('pair-review-tab:' + oracleBase64('owner/repo').replace(/=/g, ''));
    expect(key).not.toContain('=');
  });

  it('produces distinct keys for distinct repos and stable keys for the same repo', () => {
    const a = getRepoStorageKey('pair-review-instructions', 'octo', 'cat');
    const b = getRepoStorageKey('pair-review-instructions', 'octo', 'dog');
    const aAgain = getRepoStorageKey('pair-review-instructions', 'octo', 'cat');
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });

  it('handles multibyte owner/repo names', () => {
    const key = getRepoStorageKey('pair-review-tab', '日本', 'リポジトリ');
    expect(key).toBe('pair-review-tab:' + oracleBase64('日本/リポジトリ').replace(/=/g, ''));
  });
});
