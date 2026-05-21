// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
const { hashHunk, isTrivialHunk } = require('../../src/ai/hunk-hashing.js');

describe('hashHunk', () => {
  it('produces a stable hash for identical inputs', () => {
    const a = hashHunk('src/foo.ts', '@@ -1,1 +1,1 @@\n-foo\n+bar\n');
    const b = hashHunk('src/foo.ts', '@@ -1,1 +1,1 @@\n-foo\n+bar\n');
    expect(a).toBe(b);
  });

  it('produces different hashes for different file paths with same content', () => {
    const content = '@@ -1,1 +1,1 @@\n-foo\n+bar\n';
    const a = hashHunk('src/foo.ts', content);
    const b = hashHunk('src/bar.ts', content);
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different content with same path', () => {
    const a = hashHunk('src/foo.ts', '@@ -1,1 +1,1 @@\n-foo\n+bar\n');
    const b = hashHunk('src/foo.ts', '@@ -1,1 +1,1 @@\n-foo\n+baz\n');
    expect(a).not.toBe(b);
  });

  it('returns 64-char lowercase hex (SHA-256)', () => {
    const h = hashHunk('src/foo.ts', '+foo\n');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a valid hash for empty content', () => {
    const h = hashHunk('src/foo.ts', '');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isTrivialHunk', () => {
  describe('imports', () => {
    it('flags JS import reorder as imports (.js)', () => {
      const hunk = {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          "-import a from 'a';",
          "-import b from 'b';",
          "+import b from 'b';",
          "+import a from 'a';"
        ]
      };
      expect(isTrivialHunk(hunk, 'src/foo.js')).toEqual({ trivial: true, reason: 'imports' });
    });

    it('flags TS import reorder as imports (.ts)', () => {
      const hunk = {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          "-import a from 'a';",
          "-import b from 'b';",
          "+import b from 'b';",
          "+import a from 'a';"
        ]
      };
      expect(isTrivialHunk(hunk, 'src/foo.ts')).toEqual({ trivial: true, reason: 'imports' });
    });

    it('does NOT flag a NEW import not present in removed (multiset differs)', () => {
      const hunk = {
        header: '@@ -1,2 +1,3 @@',
        lines: [
          "-import a from 'a';",
          "-import b from 'b';",
          "+import a from 'a';",
          "+import b from 'b';",
          "+import c from 'c';"
        ]
      };
      const result = isTrivialHunk(hunk, 'src/foo.ts');
      expect(result.trivial).toBe(false);
    });

    it('flags require() reorder as imports', () => {
      const hunk = {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          "-const a = require('a');",
          "-const b = require('b');",
          "+const b = require('b');",
          "+const a = require('a');"
        ]
      };
      expect(isTrivialHunk(hunk, 'src/foo.js')).toEqual({ trivial: true, reason: 'imports' });
    });

    it('flags Python from-import reorder as imports', () => {
      const hunk = {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          '-from foo import bar',
          '-from baz import qux',
          '+from baz import qux',
          '+from foo import bar'
        ]
      };
      expect(isTrivialHunk(hunk, 'src/x.py')).toEqual({ trivial: true, reason: 'imports' });
    });

    it('does NOT apply import rule for non-JS/TS/Python (e.g. .go); non-trivial Go change stays non-trivial', () => {
      const hunk = {
        header: '@@ -1,5 +1,5 @@',
        lines: [
          '-import "fmt"',
          '-import "os"',
          '-x := 1',
          '-y := 2',
          '-z := 3',
          '+import "os"',
          '+import "fmt"',
          '+x := 10',
          '+y := 20',
          '+z := 30'
        ]
      };
      const result = isTrivialHunk(hunk, 'src/main.go');
      expect(result.trivial).toBe(false);
    });
  });

  describe('version_bump', () => {
    it('flags any non-empty change in package-lock.json as version_bump', () => {
      const hunk = {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          '         "version": "1.0.0",',
          '-        "resolved": "https://example.com/foo-1.0.0.tgz",',
          '+        "resolved": "https://example.com/foo-1.0.1.tgz",',
          '         "integrity": "sha512-abc"'
        ]
      };
      expect(isTrivialHunk(hunk, 'package-lock.json')).toEqual({
        trivial: true,
        reason: 'version_bump'
      });
    });

    it('flags package.json version-only line changes as version_bump', () => {
      const hunk = {
        header: '@@ -10,1 +10,1 @@',
        lines: ['-    "foo": "^1.2.3",', '+    "foo": "^1.2.4",']
      };
      expect(isTrivialHunk(hunk, 'package.json')).toEqual({
        trivial: true,
        reason: 'version_bump'
      });
    });

    it('does NOT flag package.json structural changes (e.g. adding a scripts block)', () => {
      const hunk = {
        header: '@@ -5,2 +5,5 @@',
        lines: [
          '   "name": "foo",',
          '   "version": "1.0.0",',
          '+  "scripts": {',
          '+    "test": "vitest"',
          '+  },'
        ]
      };
      const result = isTrivialHunk(hunk, 'package.json');
      expect(result.trivial).toBe(false);
    });

    it('flags package.json bump where the same key changes versions', () => {
      const hunk = {
        header: '@@ -10,1 +10,1 @@',
        lines: ['-    "foo": "^1.2.3",', '+    "foo": "^1.2.4",']
      };
      expect(isTrivialHunk(hunk, 'package.json')).toEqual({
        trivial: true,
        reason: 'version_bump'
      });
    });

    it('does NOT flag package.json swap of one dep for another at the same version', () => {
      const hunk = {
        header: '@@ -10,1 +10,1 @@',
        lines: ['-    "foo": "1.2.3",', '+    "bar": "1.2.3",']
      };
      const result = isTrivialHunk(hunk, 'package.json');
      expect(result.trivial).toBe(false);
    });
  });

  describe('generated', () => {
    it('flags as generated when isGeneratedFile returns true', () => {
      const hunk = {
        header: '@@ -1,5 +1,5 @@',
        lines: [
          '-function realChange() {',
          '-  return computeOldValue();',
          '-}',
          '+function realChange() {',
          '+  return computeNewValue();',
          '+}'
        ]
      };
      const result = isTrivialHunk(hunk, 'dist/bundle.js', {
        isGeneratedFile: () => true
      });
      expect(result).toEqual({ trivial: true, reason: 'generated' });
    });

    it('does NOT fire generated rule when isGeneratedFile is omitted', () => {
      const hunk = {
        header: '@@ -1,5 +1,5 @@',
        lines: [
          '-function realChange() {',
          '-  return computeOldValue();',
          '-}',
          '+function realChange() {',
          '+  return computeNewValue();',
          '+}'
        ]
      };
      const result = isTrivialHunk(hunk, 'dist/bundle.js');
      expect(result.trivial).toBe(false);
    });
  });

  describe('non-trivial', () => {
    it('returns trivial:false for a real 5-line code change in a .ts file', () => {
      const hunk = {
        header: '@@ -1,5 +1,5 @@',
        lines: [
          '-function compute(x: number): number {',
          '-  const a = x * 2;',
          '-  const b = a + 1;',
          '-  const c = b * b;',
          '-  return c;',
          '+function compute(x: number): number {',
          '+  const a = x * 3;',
          '+  const b = a - 1;',
          '+  const c = b ** 2;',
          '+  return c + 1;'
        ]
      };
      const result = isTrivialHunk(hunk, 'src/foo.ts');
      expect(result.trivial).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('order precedence', () => {
    it('returns generated before any other rule (generated + real code change)', () => {
      const hunk = {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          '-function realChange() {',
          '-  return computeOldValue();',
          '-}',
          '+function realChange() {',
          '+  return computeNewValue();',
          '+}'
        ]
      };
      const result = isTrivialHunk(hunk, 'dist/bundle.js', {
        isGeneratedFile: () => true
      });
      expect(result.reason).toBe('generated');
    });
  });

  describe('edge cases', () => {
    it('ignores "\\ No newline at end of file" markers', () => {
      const hunk = {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          '-function compute(x: number): number {',
          '-  const a = x * 2;',
          '-  return a;',
          '\\ No newline at end of file',
          '+function compute(x: number): number {',
          '+  const a = x * 3;',
          '+  return a;',
          '\\ No newline at end of file'
        ]
      };
      const result = isTrivialHunk(hunk, 'src/foo.ts');
      expect(result.trivial).toBe(false);
    });

    it('does NOT skip body lines that begin with "++" or "--" (e.g. C-style increment/decrement)', () => {
      const hunk = {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          '-let counter = 0;',
          '--counter;',
          '-doWork(counter);',
          '+let counter = 0;',
          '++counter;',
          '+doWork(counter);'
        ]
      };
      const result = isTrivialHunk(hunk, 'src/foo.ts');
      expect(result.trivial).toBe(false);
    });
  });
});
