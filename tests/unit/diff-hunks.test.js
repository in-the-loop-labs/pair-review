// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
const { parseHunks, parseUnifiedDiffHunks } = require('../../src/utils/diff-hunks.js');

describe('parseHunks', () => {
  it('returns [] for empty input', () => {
    expect(parseHunks('')).toEqual([]);
    expect(parseHunks(null)).toEqual([]);
    expect(parseHunks(undefined)).toEqual([]);
  });

  it('returns [] for a patch with no @@ lines (binary diff)', () => {
    const patch = [
      'diff --git a/img.png b/img.png',
      'index abc123..def456 100644',
      'Binary files a/img.png and b/img.png differ'
    ].join('\n');
    expect(parseHunks(patch)).toEqual([]);
  });

  it('returns [] for a pure-rename patch with no hunks', () => {
    const patch = [
      'diff --git a/old.js b/new.js',
      'similarity index 100%',
      'rename from old.js',
      'rename to new.js'
    ].join('\n');
    expect(parseHunks(patch)).toEqual([]);
  });

  it('parses single-hunk patch with file header lines', () => {
    const patch = [
      'diff --git a/foo.js b/foo.js',
      'index abc..def 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,3 +1,4 @@',
      ' line one',
      '-line two',
      '+line two changed',
      '+line three',
      ' line four'
    ].join('\n');

    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -1,3 +1,4 @@');
    expect(hunks[0].lines).toEqual([
      ' line one',
      '-line two',
      '+line two changed',
      '+line three',
      ' line four'
    ]);
    for (const line of hunks[0].lines) {
      expect(line.startsWith('diff --git')).toBe(false);
      expect(line.startsWith('index ')).toBe(false);
      expect(line.startsWith('--- a/')).toBe(false);
      expect(line.startsWith('+++ b/')).toBe(false);
    }
  });

  it('parses a multi-hunk patch with three hunks', () => {
    const patch = [
      'diff --git a/x.js b/x.js',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' b',
      '@@ -10,2 +10,2 @@',
      '-c',
      '+C',
      ' d',
      '@@ -20,2 +20,2 @@ context tail',
      '-e',
      '+E',
      ' f'
    ].join('\n');

    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(3);
    expect(hunks[0].header).toBe('@@ -1,2 +1,2 @@');
    expect(hunks[0].lines).toEqual(['-a', '+A', ' b']);
    expect(hunks[1].header).toBe('@@ -10,2 +10,2 @@');
    expect(hunks[1].lines).toEqual(['-c', '+C', ' d']);
    expect(hunks[2].header).toBe('@@ -20,2 +20,2 @@ context tail');
    expect(hunks[2].lines).toEqual(['-e', '+E', ' f']);
  });

  it('preserves the "\\ No newline at end of file" marker in lines', () => {
    const patch = [
      'diff --git a/foo b/foo',
      '--- a/foo',
      '+++ b/foo',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file'
    ].join('\n');

    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file'
    ]);
  });

  it('treats body lines starting with ++ or -- as content, not headers', () => {
    const patch = [
      'diff --git a/c.cpp b/c.cpp',
      '--- a/c.cpp',
      '+++ b/c.cpp',
      '@@ -1,4 +1,4 @@',
      ' int main() {',
      '-  --a;',
      '+  ++counter;',
      ' }'
    ].join('\n');

    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      ' int main() {',
      '-  --a;',
      '+  ++counter;',
      ' }'
    ]);
    expect(hunks[0].lines).toContain('+  ++counter;');
    expect(hunks[0].lines).toContain('-  --a;');
  });

  it('preserves trailing context after second @@ in hunk header', () => {
    const patch = [
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -10,5 +10,7 @@ function foo() {',
      ' a',
      '+b',
      ' c'
    ].join('\n');

    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -10,5 +10,7 @@ function foo() {');
  });

  it('is tolerant of patches without a diff --git header', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-x',
      '+y',
      ' z'
    ].join('\n');

    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -1,2 +1,2 @@');
    expect(hunks[0].lines).toEqual(['-x', '+y', ' z']);
  });
});

describe('parseUnifiedDiffHunks', () => {
  it('returns empty Map for empty input', () => {
    const result = parseUnifiedDiffHunks('');
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(parseUnifiedDiffHunks(null).size).toBe(0);
  });

  it('parses a two-file diff into a Map with two entries', () => {
    const diff = [
      'diff --git a/foo.js b/foo.js',
      'index abc..def 100644',
      '--- a/foo.js',
      '+++ b/foo.js',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' tail',
      'diff --git a/bar.js b/bar.js',
      'index 111..222 100644',
      '--- a/bar.js',
      '+++ b/bar.js',
      '@@ -5,1 +5,2 @@',
      ' keep',
      '+added'
    ].join('\n');

    const result = parseUnifiedDiffHunks(diff);
    expect(result.size).toBe(2);
    expect(result.get('foo.js')).toBeDefined();
    expect(result.get('foo.js')).toHaveLength(1);
    expect(result.get('foo.js')[0].header).toBe('@@ -1,2 +1,2 @@');
    expect(result.get('bar.js')).toBeDefined();
    expect(result.get('bar.js')).toHaveLength(1);
    expect(result.get('bar.js')[0].header).toBe('@@ -5,1 +5,2 @@');
  });

  it('strips the b/ prefix from nested file paths', () => {
    const diff = [
      'diff --git a/path/to/file.js b/path/to/file.js',
      '--- a/path/to/file.js',
      '+++ b/path/to/file.js',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    ].join('\n');

    const result = parseUnifiedDiffHunks(diff);
    expect(result.has('path/to/file.js')).toBe(true);
    expect(result.has('b/path/to/file.js')).toBe(false);
  });

  it('omits files whose patch yields zero hunks (pure rename)', () => {
    const diff = [
      'diff --git a/old.js b/new.js',
      'similarity index 100%',
      'rename from old.js',
      'rename to new.js',
      'diff --git a/real.js b/real.js',
      '--- a/real.js',
      '+++ b/real.js',
      '@@ -1 +1 @@',
      '-a',
      '+b'
    ].join('\n');

    const result = parseUnifiedDiffHunks(diff);
    expect(result.has('new.js')).toBe(false);
    expect(result.has('real.js')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('keys deletions on the path from the diff header (b/ side)', () => {
    const diff = [
      'diff --git a/gone.js b/gone.js',
      'deleted file mode 100644',
      'index abc..0000000',
      '--- a/gone.js',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two'
    ].join('\n');

    const result = parseUnifiedDiffHunks(diff);
    expect(result.size).toBe(1);
    expect(result.has('gone.js')).toBe(true);
    expect(result.get('gone.js')).toHaveLength(1);
    expect(result.get('gone.js')[0].lines).toEqual(['-line one', '-line two']);
  });
});
